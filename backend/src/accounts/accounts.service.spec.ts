import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import {
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import { UserRole } from '../database/entities/user.entity';
import {
  buildMockAccount,
  buildMockUser,
  createMockRepository,
} from '../test-utils/mock-helpers';

describe('AccountsService — Tính số dư khả dụng, Xem tài khoản cá nhân & Kiểm tra quyền sở hữu RBAC', () => {
  let service: AccountsService;
  let accountRepo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    accountRepo = createMockRepository();
    service = new AccountsService(accountRepo as any);
  });

  describe('computeAvailableBalance (Các trường hợp biên của balance − hold_amount)', () => {
    it.each([
      ['số dư = 0, hold = 0', '0.00', '0.00', '0.00'],
      ['số dư dương, hold = 0', '5000000.00', '0.00', '5000000.00'],
      ['số dư 1,000,000, hold 400,000', '1000000.00', '400000.00', '600000.00'],
      [
        'hold đúng bằng balance (khả dụng = 0)',
        '1000000.00',
        '1000000.00',
        '0.00',
      ],
      [
        'chênh lệch đúng 1 đơn vị nhỏ nhất (0.01đ)',
        '1000000.00',
        '999999.99',
        '0.01',
      ],
      [
        'dữ liệu hỏng: số dư âm hoặc hold > balance trả về số âm',
        '100.00',
        '100.01',
        '-0.01',
      ],
      ['dữ liệu hỏng: balance âm ngay từ đầu', '-50.00', '0.00', '-50.00'],
    ])(
      'tính đúng availableBalance cho trường hợp %s (%s - %s = %s)',
      (_label, balance, hold, expected) => {
        expect(service.computeAvailableBalance(balance, hold)).toBe(expected);
      },
    );
  });

  describe('getMyAccount', () => {
    it('trả về thông tin tài khoản đầy đủ (kèm holdAmount, availableBalance, status, tier, limits) khi tìm thấy', async () => {
      const user = buildMockUser({
        id: 'user-cust-1',
        full_name: 'Customer One',
      });
      const account = buildMockAccount({
        id: 'acc-1',
        user_id: user.id,
        user,
        account_number: '1000000001',
        balance: '5000000.00',
        hold_amount: '400000.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
      });

      accountRepo.findOne.mockResolvedValueOnce(account);
      accountRepo.manager.query.mockResolvedValueOnce([
        { used_today: '12000000.00' },
      ]);

      const result = await service.getMyAccount(user.id);

      expect(accountRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: user.id },
        relations: { user: true },
      });
      expect(result).toEqual({
        id: 'acc-1',
        accountNumber: '1000000001',
        balance: '5000000.00',
        holdAmount: '400000.00',
        availableBalance: '4600000.00',
        status: AccountStatus.ACTIVE,
        tier: AccountTier.STANDARD,
        limits: {
          perTransaction: '30000000.00',
          perDay: '50000000.00',
          usedToday: '12000000.00',
          remainingToday: '38000000.00',
        },
        currency: 'VND',
        ownerName: 'Customer One',
        createdAt: account.created_at,
      });
    });

    it('ném 404 NotFoundException khi không tìm thấy tài khoản của người dùng (hoặc đã xóa mềm)', async () => {
      accountRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getMyAccount('missing-user-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getAccountByNumber (Kiểm tra quyền sở hữu RBAC giữa CUSTOMER và ADMIN)', () => {
    it('cho phép CUSTOMER xem tài khoản của chính mình (200 OK)', async () => {
      const customer = buildMockUser({
        id: 'cust-1',
        role: UserRole.CUSTOMER,
        full_name: 'Chu Tai Khoan',
      });
      const ownAccount = buildMockAccount({
        user_id: customer.id,
        user: customer,
        account_number: '1000000001',
        balance: '2000000.00',
        hold_amount: undefined as any, // Kiểm tra nhánh fallback hold_amount ?? '0.00'
        tier: AccountTier.VIP,
      });

      accountRepo.findOne.mockResolvedValueOnce(ownAccount);
      accountRepo.manager.query.mockResolvedValueOnce([{ used_today: '0.00' }]);

      const result = await service.getAccountByNumber('  1000000001  ', {
        id: customer.id,
        role: UserRole.CUSTOMER,
      });

      expect(result.accountNumber).toBe('1000000001');
      expect(result.holdAmount).toBe('0.00');
      expect(result.availableBalance).toBe('2000000.00');
      expect(result.limits.perDay).toBe('200000000.00');
    });

    it('từ chối với 403 ForbiddenException khi CUSTOMER cố tình tra cứu số tài khoản của người khác', async () => {
      const otherAccount = buildMockAccount({
        user_id: 'other-user-id',
        account_number: '1000000002',
      });
      accountRepo.findOne.mockResolvedValueOnce(otherAccount);

      await expect(
        service.getAccountByNumber('1000000002', {
          id: 'my-user-id',
          role: UserRole.CUSTOMER,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('từ chối với 403 ForbiddenException khi CUSTOMER tra cứu một số tài khoản không tồn tại', async () => {
      accountRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getAccountByNumber('9999999999', {
          id: 'my-user-id',
          role: UserRole.CUSTOMER,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('cho phép ADMIN xem tài khoản của bất kỳ người dùng nào (200 OK)', async () => {
      const targetUser = buildMockUser({
        id: 'cust-2',
        full_name: 'Khach Hang B',
      });
      const targetAccount = buildMockAccount({
        user_id: targetUser.id,
        user: targetUser,
        account_number: '1000000002',
        balance: '8000000.00',
        hold_amount: '1000000.00',
      });

      accountRepo.findOne.mockResolvedValueOnce(targetAccount);
      accountRepo.manager.query.mockResolvedValueOnce([
        { used_today: '5000000.00' },
      ]);

      const result = await service.getAccountByNumber('1000000002', {
        id: 'admin-user-id',
        role: UserRole.ADMIN,
      });

      expect(result.accountNumber).toBe('1000000002');
      expect(result.availableBalance).toBe('7000000.00');
      expect(result.ownerName).toBe('Khach Hang B');
    });

    it('ném 404 NotFoundException khi ADMIN tra cứu số tài khoản không tồn tại (hoặc đã xóa mềm)', async () => {
      accountRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getAccountByNumber('9999999999', {
          id: 'admin-user-id',
          role: UserRole.ADMIN,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
