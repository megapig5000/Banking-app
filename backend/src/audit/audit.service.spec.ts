import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, lastValueFrom } from 'rxjs';
import { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';
import { UserAuditSubscriber } from './user-audit.subscriber';
import { AccountAuditSubscriber } from './account-audit.subscriber';
import { AuditAction, AuditEntity } from './audit.constants';
import { AuditLog } from '../database/entities/audit-log.entity';
import { UserStatus } from '../database/entities/user.entity';
import {
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import { SortOrder } from '../transactions/dto/transaction-query.dto';
import {
  buildMockAccount,
  buildMockUser,
  createMockEntityManager,
  createMockRepository,
} from '../test-utils/mock-helpers';

describe('AuditService, AuditInterceptor, UserAuditSubscriber & AccountAuditSubscriber — Nhật ký kiểm toán tự động', () => {
  let auditService: AuditService;
  let auditRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    auditRepo = createMockRepository();
    auditService = new AuditService(auditRepo as any);
  });

  describe('AuditService', () => {
    it('recordAuditLog chèn bản ghi vào audit_logs và cắt ngắn ipAddress / userAgent vượt độ dài tối đa', async () => {
      const customManager = createMockEntityManager();
      await auditService.recordAuditLog(
        {
          actorId: 'actor-1',
          action: AuditAction.USER_STATUS_CHANGED,
          entity: AuditEntity.USERS,
          entityId: 'target-1',
          ipAddress: '1'.repeat(100),
          userAgent: 'U'.repeat(300),
          beforeData: { status: 'active' },
          afterData: { status: 'locked' },
        },
        customManager as any,
      );

      expect(customManager.insert).toHaveBeenCalledWith(
        AuditLog,
        expect.objectContaining({
          actor_id: 'actor-1',
          action: AuditAction.USER_STATUS_CHANGED,
          entity: AuditEntity.USERS,
          entity_id: 'target-1',
          ip_address: '1'.repeat(64),
          user_agent: 'U'.repeat(255),
        }),
      );
    });

    it('recordAuditLogBestEffort bắt lỗi và log error chứ không làm vỡ luồng chính khi DB gặp sự cố', async () => {
      auditRepo.manager.insert.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );
      const loggerSpy = jest
        .spyOn((auditService as any).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(
        auditService.recordAuditLogBestEffort({
          action: AuditAction.AUTH_LOGIN_SUCCESS,
          entity: AuditEntity.USERS,
        }),
      ).resolves.toBeUndefined();

      expect(loggerSpy).toHaveBeenCalledTimes(1);
    });

    it('getAuditLogs từ chối khi fromDate > toDate (400) và lọc đúng theo actorId, action, entity, entityId, ngày', async () => {
      await expect(
        auditService.getAuditLogs({
          fromDate: '2026-12-31',
          toDate: '2026-01-01',
        }),
      ).rejects.toThrow(BadRequestException);

      const actor = buildMockUser({
        id: 'admin-1',
        full_name: 'System Admin',
        email: 'admin@bank.local',
      });
      auditRepo.queryBuilder.getManyAndCount.mockResolvedValueOnce([
        [
          {
            id: '10',
            actor,
            action: AuditAction.USER_STATUS_CHANGED,
            entity: AuditEntity.USERS,
            entity_id: 'u-1',
            ip_address: '127.0.0.1',
            user_agent: 'Jest',
            before_data: { status: 'active' },
            after_data: { status: 'locked' },
            created_at: new Date('2026-03-01T00:00:00Z'),
          },
          {
            id: '9',
            actor: null,
            action: AuditAction.AUTH_LOGIN_FAILED,
            entity: AuditEntity.USERS,
            entity_id: null,
            ip_address: '127.0.0.1',
            user_agent: null,
            before_data: null,
            after_data: { email: 'bad@bank.local' },
            created_at: new Date('2026-03-01T00:00:00Z'),
          },
        ],
        2,
      ]);

      const res = await auditService.getAuditLogs({
        page: 1,
        limit: 10,
        actorId: 'admin-1',
        action: AuditAction.USER_STATUS_CHANGED,
        entity: 'users',
        entityId: 'u-1',
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
        order: SortOrder.DESC,
      });

      expect(res.meta.total).toBe(2);
      expect(res.data[0].actor).toEqual({
        id: 'admin-1',
        fullName: 'System Admin',
        email: 'admin@bank.local',
      });
      expect(res.data[1].actor).toBeNull();
    });
  });

  describe('AuditInterceptor', () => {
    let interceptor: AuditInterceptor;
    let mockReflector: { get: jest.Mock };
    let recordBestEffortSpy: jest.SpyInstance;

    beforeEach(() => {
      mockReflector = { get: jest.fn() };
      interceptor = new AuditInterceptor(
        mockReflector as unknown as Reflector,
        auditService,
      );
      recordBestEffortSpy = jest
        .spyOn(auditService, 'recordAuditLogBestEffort')
        .mockResolvedValue(undefined);
    });

    function createHttpContext(req: any = {}, res: any = { statusCode: 200 }) {
      return {
        getHandler: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
      } as unknown as ExecutionContext;
    }

    it('đi thẳng qua next.handle() khi handler không gắn metadata @Audit()', async () => {
      mockReflector.get.mockReturnValueOnce(undefined);
      const next: CallHandler = { handle: () => of({ ok: true }) };

      const result = await lastValueFrom(
        interceptor.intercept(createHttpContext(), next),
      );
      expect(result).toEqual({ ok: true });
      expect(recordBestEffortSpy).not.toHaveBeenCalled();
    });

    it('ghi nhận bản ghi SUCCESS (kể cả khi Controller dùng @Res() gọi res.json(body))', async () => {
      mockReflector.get.mockReturnValueOnce({
        action: AuditAction.TRANSACTION_REVERSED,
        entity: AuditEntity.TRANSACTIONS,
        onSuccess: (_req: any, body: any) => ({
          entityId: body?.originalTransactionId,
          afterData: { reversalId: body?.id },
        }),
      });

      const mockRes: any = {
        statusCode: 201,
        json: jest.fn((body: any) => body),
      };
      const ctx = createHttpContext({ params: { id: 'orig-1' } }, mockRes);

      const next: CallHandler = {
        handle: () => {
          mockRes.json({ id: 'rev-1', originalTransactionId: 'orig-1' });
          return of(mockRes);
        },
      };

      await lastValueFrom(interceptor.intercept(ctx, next));

      expect(recordBestEffortSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.TRANSACTION_REVERSED,
          entity: AuditEntity.TRANSACTIONS,
          entityId: 'orig-1',
          afterData: {
            reversalId: 'rev-1',
            outcome: 'SUCCESS',
            httpStatus: 201,
          },
        }),
      );
    });

    it('khi handler ném lỗi: ghi nhận failureAction với outcome = ERROR rồi NÉM LẠI ĐÚNG LỖI ĐÓ (không nuốt lỗi)', async () => {
      mockReflector.get.mockReturnValueOnce({
        action: AuditAction.AUTH_LOGIN_SUCCESS,
        failureAction: AuditAction.AUTH_LOGIN_FAILED,
        entity: AuditEntity.USERS,
        onError: (req: any, err: any) => ({
          actorId: null,
          afterData: { email: req.body?.email, reason: err.message },
        }),
      });

      const ctx = createHttpContext({ body: { email: 'hacker@bank.local' } });
      const authError = new UnauthorizedException(
        'Email hoặc mật khẩu không đúng',
      );
      const next: CallHandler = {
        handle: () => throwError(() => authError),
      };

      await expect(
        lastValueFrom(interceptor.intercept(ctx, next)),
      ).rejects.toThrow(UnauthorizedException);

      expect(recordBestEffortSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: null,
          action: AuditAction.AUTH_LOGIN_FAILED,
          afterData: {
            email: 'hacker@bank.local',
            reason: 'Email hoặc mật khẩu không đúng',
            outcome: 'ERROR',
            httpStatus: 401,
          },
        }),
      );
    });
  });

  describe('UserAuditSubscriber & AccountAuditSubscriber', () => {
    it('UserAuditSubscriber: ghi USER_STATUS_CHANGED khi chỉ đổi status, ghi USER_UPDATED khi đổi trường khác, ghi USER_SOFT_DELETED khi xóa mềm (chống ghi đúp bằng WeakSet), và bỏ qua khi không đổi gì', async () => {
      const subscribers: any[] = [];
      const sub = new UserAuditSubscriber({ subscribers } as any);
      expect(subscribers).toHaveLength(1);
      expect(sub.listenTo()).toBeDefined();

      const manager = createMockEntityManager();
      const user = buildMockUser({
        id: 'u-1',
        full_name: 'Old Name',
        status: UserStatus.ACTIVE,
      });

      sub.afterLoad(user);

      await sub.afterUpdate({ entity: user, manager } as any);
      expect(manager.insert).not.toHaveBeenCalled();

      user.status = UserStatus.LOCKED;
      await sub.afterUpdate({ entity: user, manager } as any);
      expect(manager.insert).toHaveBeenLastCalledWith(
        AuditLog,
        expect.objectContaining({
          action: AuditAction.USER_STATUS_CHANGED,
          before_data: { status: UserStatus.ACTIVE },
          after_data: { status: UserStatus.LOCKED },
        }),
      );

      user.full_name = 'New Name';
      user.phone = '0901234567';
      await sub.afterUpdate({ entity: user, manager } as any);
      expect(manager.insert).toHaveBeenLastCalledWith(
        AuditLog,
        expect.objectContaining({
          action: AuditAction.USER_UPDATED,
          before_data: { fullName: 'Old Name', phone: null },
          after_data: { fullName: 'New Name', phone: '0901234567' },
        }),
      );

      user.deleted_at = new Date('2026-03-05T00:00:00Z');
      const countBeforeSoftDel = manager.insert.mock.calls.length;
      await sub.afterUpdate({ entity: user, manager } as any);
      await sub.afterSoftRemove({ entity: user, manager } as any);

      expect(manager.insert.mock.calls.length).toBe(countBeforeSoftDel + 1);
      expect(manager.insert).toHaveBeenLastCalledWith(
        AuditLog,
        expect.objectContaining({
          action: AuditAction.USER_SOFT_DELETED,
          entity_id: 'u-1',
        }),
      );
    });

    it('AccountAuditSubscriber: chụp snapshot lúc afterLoad, ghi ACCOUNT_UPDATED khi đổi status/tier/holdAmount, và bỏ qua khi chỉ đổi balance', async () => {
      const subscribers: any[] = [];
      const accSub = new AccountAuditSubscriber({ subscribers } as any);
      expect(subscribers).toHaveLength(1);
      expect(accSub.listenTo()).toBeDefined();

      const manager = createMockEntityManager();
      const account = buildMockAccount({
        id: 'acc-1',
        balance: '1000000.00',
        hold_amount: '0.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
      });

      accSub.afterLoad(account);

      account.balance = '2000000.00';
      await accSub.afterUpdate({ entity: account, manager } as any);
      expect(manager.insert).not.toHaveBeenCalled();

      account.status = AccountStatus.FROZEN;
      account.tier = AccountTier.VIP;
      account.hold_amount = '400000.00';
      await accSub.afterUpdate({ entity: account, manager } as any);

      expect(manager.insert).toHaveBeenCalledWith(
        AuditLog,
        expect.objectContaining({
          action: AuditAction.ACCOUNT_UPDATED,
          entity: AuditEntity.ACCOUNTS,
          entity_id: 'acc-1',
          before_data: {
            status: AccountStatus.ACTIVE,
            tier: AccountTier.STANDARD,
            holdAmount: '0.00',
          },
          after_data: {
            status: AccountStatus.FROZEN,
            tier: AccountTier.VIP,
            holdAmount: '400000.00',
          },
        }),
      );
    });
  });
});
