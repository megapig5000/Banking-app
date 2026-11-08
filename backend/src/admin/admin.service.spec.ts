import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import {
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../database/entities/transaction.entity';
import { User, UserRole, UserStatus } from '../database/entities/user.entity';
import { SortOrder } from '../transactions/dto/transaction-query.dto';
import {
  buildMockAccount,
  buildMockTransaction,
  buildMockUser,
  createMockEntityManager,
  createMockRepository,
} from '../test-utils/mock-helpers';

describe('AdminService — Quản lý người dùng, Khóa/Xóa mềm, Quản lý trạng thái/hạn mức/hold tài khoản & Giám sát giao dịch', () => {
  let service: AdminService;
  let userRepo: ReturnType<typeof createMockRepository>;
  let accountRepo: ReturnType<typeof createMockRepository>;
  let txRepo: ReturnType<typeof createMockRepository>;
  let mockManager: ReturnType<typeof createMockEntityManager>;
  let mockDataSource: { transaction: jest.Mock };
  let mockAuditService: { getAuditLogs: jest.Mock };
  let mockUsersService: { getProfileHistory: jest.Mock };

  beforeEach(() => {
    userRepo = createMockRepository();
    accountRepo = createMockRepository();
    txRepo = createMockRepository();
    mockManager = createMockEntityManager();
    mockDataSource = {
      transaction: jest.fn(async (cb: any) => cb(mockManager)),
    };
    mockAuditService = {
      getAuditLogs: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    };
    mockUsersService = {
      getProfileHistory: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    };

    service = new AdminService(
      userRepo as any,
      accountRepo as any,
      txRepo as any,
      mockDataSource as any,
      mockAuditService as any,
      mockUsersService as any,
    );
  });

  describe('getUsers & getUserProfileHistory', () => {
    it('lọc danh sách người dùng theo status, role, hỗ trợ includeDeleted=true và không lộ password_hash', async () => {
      const acc = buildMockAccount({
        account_number: '1000000001',
        balance: '5000000.00',
        hold_amount: '400000.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.VIP,
      });
      const userWithAcc = buildMockUser({
        id: 'u-1',
        accounts: [acc],
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      const userWithoutAcc = buildMockUser({
        id: 'u-2',
        accounts: [],
        deleted_at: new Date('2026-03-01T00:00:00Z'),
      });

      userRepo.queryBuilder.getManyAndCount.mockResolvedValueOnce([
        [userWithAcc, userWithoutAcc],
        2,
      ]);

      const res = await service.getUsers({
        page: 1,
        limit: 10,
        status: UserStatus.ACTIVE,
        role: UserRole.CUSTOMER,
        includeDeleted: true,
        order: SortOrder.ASC,
      });

      expect(userRepo.queryBuilder.withDeleted).toHaveBeenCalledTimes(1);
      expect(res.meta).toEqual({
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
      });
      expect(res.data[0]).toMatchObject({
        id: 'u-1',
        accountNumber: '1000000001',
        accountStatus: AccountStatus.ACTIVE,
        accountTier: AccountTier.VIP,
        holdAmount: '400000.00',
        availableBalance: '4600000.00',
      });
      expect((res.data[0] as any).password_hash).toBeUndefined();
      expect(res.data[1]).toMatchObject({
        id: 'u-2',
        accountNumber: null,
        holdAmount: null,
        availableBalance: null,
      });
    });

    it('getUserProfileHistory ủy quyền cho UsersService.getProfileHistory với allowDeletedUser = true', async () => {
      await service.getUserProfileHistory('user-target-1', {
        page: 1,
        limit: 5,
      });
      expect(mockUsersService.getProfileHistory).toHaveBeenCalledWith(
        'user-target-1',
        { page: 1, limit: 5 },
        true,
      );
    });
  });

  describe('updateUserStatus', () => {
    it('chặn Admin tự khóa chính mình (400) và ném 404 khi không tìm thấy người dùng', async () => {
      await expect(
        service.updateUserStatus('admin-1', 'admin-1', {
          status: UserStatus.LOCKED,
        }),
      ).rejects.toThrow(BadRequestException);

      mockManager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.updateUserStatus('admin-1', 'missing-user', {
          status: UserStatus.LOCKED,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('không gọi save() khi trạng thái không đổi (No-op), và gọi save(User, user) khi trạng thái thay đổi', async () => {
      const user = buildMockUser({
        id: 'target-1',
        status: UserStatus.LOCKED,
        accounts: [buildMockAccount()],
      });

      mockManager.findOne.mockResolvedValueOnce(user);
      const noOpRes = await service.updateUserStatus('admin-1', 'target-1', {
        status: UserStatus.LOCKED,
      });
      expect(noOpRes.status).toBe(UserStatus.LOCKED);
      expect(mockManager.save).not.toHaveBeenCalled();

      mockManager.findOne.mockResolvedValueOnce(user);
      const changedRes = await service.updateUserStatus('admin-1', 'target-1', {
        status: UserStatus.ACTIVE,
      });
      expect(changedRes.status).toBe(UserStatus.ACTIVE);
      expect(mockManager.save).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ status: UserStatus.ACTIVE }),
      );
    });
  });

  describe('softDeleteUser', () => {
    it('từ chối khi Admin tự xóa chính mình (400), user không tồn tại (404), hoặc cố tình xóa một ADMIN khác (403)', async () => {
      await expect(
        service.softDeleteUser('admin-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);

      mockManager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.softDeleteUser('admin-1', 'missing-user'),
      ).rejects.toThrow(NotFoundException);

      mockManager.findOne.mockResolvedValueOnce(
        buildMockUser({ id: 'admin-2', role: UserRole.ADMIN }),
      );
      await expect(
        service.softDeleteUser('admin-1', 'admin-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('từ chối với 409 ConflictException khi tài khoản còn số dư > 0, còn holdAmount > 0, hoặc còn giao dịch đang xử lý dở', async () => {
      const targetUser = buildMockUser({
        id: 'cust-1',
        role: UserRole.CUSTOMER,
      });

      mockManager.findOne.mockResolvedValueOnce(targetUser);
      mockManager.queryBuilder.getMany.mockResolvedValueOnce([
        buildMockAccount({ balance: '100.00', hold_amount: '0.00' }),
      ]);
      await expect(service.softDeleteUser('admin-1', 'cust-1')).rejects.toThrow(
        ConflictException,
      );

      mockManager.findOne.mockResolvedValueOnce(targetUser);
      mockManager.queryBuilder.getMany.mockResolvedValueOnce([
        buildMockAccount({ balance: '0.00', hold_amount: '50.00' }),
      ]);
      await expect(service.softDeleteUser('admin-1', 'cust-1')).rejects.toThrow(
        ConflictException,
      );

      mockManager.findOne.mockResolvedValueOnce(targetUser);
      mockManager.queryBuilder.getMany.mockResolvedValueOnce([
        buildMockAccount({ balance: '0.00', hold_amount: '0.00' }),
      ]);
      mockManager.queryBuilder.getCount.mockResolvedValueOnce(1);
      await expect(service.softDeleteUser('admin-1', 'cust-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('xóa mềm thành công khi đủ điều kiện: đóng tài khoản sang CLOSED, gọi softRemove cho cả Account và User trong cùng transaction', async () => {
      const targetUser = buildMockUser({
        id: 'cust-clean',
        role: UserRole.CUSTOMER,
      });
      const targetAcc = buildMockAccount({
        id: 'acc-clean',
        user_id: targetUser.id,
        balance: '0.00',
        hold_amount: '0.00',
        status: AccountStatus.ACTIVE,
      });

      mockManager.findOne.mockResolvedValueOnce(targetUser);
      mockManager.queryBuilder.getMany.mockResolvedValueOnce([targetAcc]);
      mockManager.queryBuilder.getCount.mockResolvedValueOnce(0);

      await service.softDeleteUser('admin-1', 'cust-clean');

      expect(targetAcc.status).toBe(AccountStatus.CLOSED);
      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(mockManager.softRemove).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateAccount', () => {
    it('từ chối khi body rỗng (400), tài khoản không tồn tại (404), hoặc đổi status từ tài khoản đã CLOSED (409)', async () => {
      await expect(service.updateAccount('1000000001', {})).rejects.toThrow(
        BadRequestException,
      );

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(null);
      await expect(
        service.updateAccount('9999999999', { tier: AccountTier.VIP }),
      ).rejects.toThrow(NotFoundException);

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(
        buildMockAccount({ status: AccountStatus.CLOSED }),
      );
      await expect(
        service.updateAccount('1000000001', { status: AccountStatus.ACTIVE }),
      ).rejects.toThrow(ConflictException);
    });

    it('từ chối với 422 khi holdAmount > balance, và từ chối với 409 khi chuyển sang CLOSED lúc còn balance > 0, còn hold > 0 hoặc còn giao dịch dở', async () => {
      mockManager.queryBuilder.getOne.mockResolvedValueOnce(
        buildMockAccount({
          balance: '500000.00',
          status: AccountStatus.ACTIVE,
        }),
      );
      await expect(
        service.updateAccount('1000000001', { holdAmount: '600000.00' }),
      ).rejects.toThrow(UnprocessableEntityException);

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(
        buildMockAccount({
          balance: '100.00',
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
        }),
      );
      await expect(
        service.updateAccount('1000000001', { status: AccountStatus.CLOSED }),
      ).rejects.toThrow(ConflictException);

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(
        buildMockAccount({
          balance: '0.00',
          hold_amount: '50.00',
          status: AccountStatus.ACTIVE,
        }),
      );
      await expect(
        service.updateAccount('1000000001', { status: AccountStatus.CLOSED }),
      ).rejects.toThrow(ConflictException);

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(
        buildMockAccount({
          balance: '0.00',
          hold_amount: '0.00',
          status: AccountStatus.ACTIVE,
        }),
      );
      mockManager.queryBuilder.getCount.mockResolvedValueOnce(2);
      await expect(
        service.updateAccount('1000000001', { status: AccountStatus.CLOSED }),
      ).rejects.toThrow(ConflictException);
    });

    it('không gọi save() khi giá trị không đổi (No-op), và lưu thành công khi đổi status, tier hoặc holdAmount', async () => {
      const account = buildMockAccount({
        account_number: '1000000001',
        balance: '1000000.00',
        hold_amount: '200000.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
      });

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(account);
      const noOpRes = await service.updateAccount('1000000001', {
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
        holdAmount: '200000',
      });
      expect(noOpRes.availableBalance).toBe('800000.00');
      expect(mockManager.save).not.toHaveBeenCalled();

      mockManager.queryBuilder.getOne.mockResolvedValueOnce(account);
      const updatedRes = await service.updateAccount('1000000001', {
        status: AccountStatus.FROZEN,
        tier: AccountTier.VIP,
        holdAmount: '400000.00',
      });

      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(updatedRes).toMatchObject({
        status: AccountStatus.FROZEN,
        tier: AccountTier.VIP,
        holdAmount: '400000.00',
        availableBalance: '600000.00',
      });
    });
  });

  describe('getTransactions & getAuditLogs', () => {
    it('getTransactions từ chối khi fromDate > toDate (400) và lọc đúng theo status, type, accountNumber, ngày kèm reversalTransactionId', async () => {
      await expect(
        service.getTransactions({
          fromDate: '2026-12-31',
          toDate: '2026-01-01',
        }),
      ).rejects.toThrow(BadRequestException);

      const fromAcc = buildMockAccount({ account_number: '1000000001' });
      const toAcc = buildMockAccount({ account_number: '1000000002' });
      const reversedTx = buildMockTransaction({
        id: 'tx-orig-1',
        fromAccount: fromAcc,
        toAccount: toAcc,
        status: TransactionStatus.REVERSED,
        type: TransactionType.TRANSFER,
      });

      txRepo.queryBuilder.getManyAndCount.mockResolvedValueOnce([
        [reversedTx],
        1,
      ]);
      txRepo.find.mockResolvedValueOnce([
        {
          id: 'tx-rev-child-1',
          original_transaction_id: 'tx-orig-1',
        },
      ]);

      const res = await service.getTransactions({
        page: 1,
        limit: 10,
        status: TransactionStatus.REVERSED,
        type: TransactionType.TRANSFER,
        accountNumber: '1000000001',
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
      });

      expect(txRepo.queryBuilder.withDeleted).toHaveBeenCalledTimes(1);
      expect(res.data[0]).toMatchObject({
        id: 'tx-orig-1',
        fromAccountNumber: '1000000001',
        toAccountNumber: '1000000002',
        reversalTransactionId: 'tx-rev-child-1',
      });
    });

    it('getAuditLogs ủy quyền cho AuditService.getAuditLogs', async () => {
      await service.getAuditLogs({ page: 1, limit: 10 });
      expect(mockAuditService.getAuditLogs).toHaveBeenCalledWith({
        page: 1,
        limit: 10,
      });
    });
  });
});
