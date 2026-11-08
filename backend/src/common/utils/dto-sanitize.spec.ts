import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { sanitizeHtml } from './sanitize.util';
import { RegisterDto } from '../../auth/dto/register.dto';
import { LoginDto } from '../../auth/dto/login.dto';
import { TransferDto } from '../../transactions/dto/transfer.dto';
import { CashTransactionDto } from '../../transactions/dto/cash-transaction.dto';
import { ReverseTransactionDto } from '../../transactions/dto/reverse-transaction.dto';
import {
  SortOrder,
  TransactionDirection,
  TransactionQueryDto,
} from '../../transactions/dto/transaction-query.dto';
import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
import { ProfileHistoryQueryDto } from '../../users/dto/profile-history-query.dto';
import { UpdateAccountAdminDto } from '../../admin/dto/update-account-admin.dto';
import { UpdateUserStatusDto } from '../../admin/dto/update-user-status.dto';
import { AdminUsersQueryDto } from '../../admin/dto/admin-users-query.dto';
import { AdminTransactionsQueryDto } from '../../admin/dto/admin-transactions-query.dto';
import { AdminAuditLogsQueryDto } from '../../admin/dto/admin-audit-logs-query.dto';
import {
  AccountStatus,
  AccountTier,
} from '../../database/entities/account.entity';
import { UserRole, UserStatus } from '../../database/entities/user.entity';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, any>,
) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, errors };
}

describe('sanitize.util & DTO Validation — Kiểm thử Sanitize XSS và các trường hợp biên của DTO', () => {
  describe('sanitizeHtml', () => {
    it('giữ nguyên chuỗi rỗng hoặc chuỗi văn bản bình thường không có ký tự đặc biệt', () => {
      expect(sanitizeHtml('')).toBe('');
      expect(sanitizeHtml('Chuyen tien mua sach 123')).toBe(
        'Chuyen tien mua sach 123',
      );
    });

    it('chuyển đổi chính xác các ký tự <, >, & thành HTML entities trong một lượt mà không gây escape kép', () => {
      const malicious = 'Nguyen <script>alert(1)&hack()</script> Van A';
      const sanitized = sanitizeHtml(malicious);
      expect(sanitized).toBe(
        'Nguyen &lt;script&gt;alert(1)&amp;hack()&lt;/script&gt; Van A',
      );
      // Không bị biến '&' của '&lt;' thành '&amp;lt;' trong cùng một lần gọi
      expect(sanitized).not.toContain('&amp;lt;');
    });
  });

  describe('RegisterDto & LoginDto', () => {
    it('chuẩn hóa email (trim + toLowerCase) và fullName (trim) hợp lệ', async () => {
      const { instance, errors } = await validateDto(RegisterDto, {
        fullName: '  Nguyen Van A  ',
        email: '  USER1@Bank.Local  ',
        password: 'Password@123',
      });

      expect(errors).toHaveLength(0);
      expect(instance.fullName).toBe('Nguyen Van A');
      expect(instance.email).toBe('user1@bank.local');
    });

    it.each([
      ['ngắn hơn 8 ký tự (7 ký tự)', 'Pass12a'],
      [
        'dài hơn 50 ký tự (51 ký tự - vượt giới hạn an toàn bcrypt)',
        `${'A'.repeat(49)}1a`,
      ],
      ['chỉ có chữ cái, thiếu chữ số', 'PasswordOnlyLetters'],
      ['chỉ có chữ số, thiếu chữ cái', '1234567890'],
      ['rỗng', ''],
    ])(
      'từ chối mật khẩu không hợp lệ: %s',
      async (_reason, invalidPassword) => {
        const { errors } = await validateDto(RegisterDto, {
          fullName: 'Nguyen Van A',
          email: 'valid@bank.local',
          password: invalidPassword,
        });
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it.each([
      ['đúng biên tối thiểu 8 ký tự', 'Pass1234'],
      ['đúng biên tối đa 50 ký tự', `${'A'.repeat(48)}1a`],
    ])(
      'chấp nhận mật khẩu ở giá trị biên hợp lệ: %s',
      async (_label, validPassword) => {
        const { errors } = await validateDto(RegisterDto, {
          fullName: 'Nguyen Van A',
          email: 'valid@bank.local',
          password: validPassword,
        });
        expect(errors).toHaveLength(0);
      },
    );

    it('LoginDto chuẩn hóa email về chữ thường và từ chối khi thiếu password', async () => {
      const validLogin = await validateDto(LoginDto, {
        email: '  ADMIN@BANK.LOCAL ',
        password: 'Password@123',
      });
      expect(validLogin.errors).toHaveLength(0);
      expect(validLogin.instance.email).toBe('admin@bank.local');

      const missingPass = await validateDto(LoginDto, {
        email: 'admin@bank.local',
        password: '',
      });
      expect(missingPass.errors.length).toBeGreaterThan(0);
    });
  });

  describe('TransferDto, CashTransactionDto & ReverseTransactionDto (Kiểm tra biên số tiền amount)', () => {
    it.each([
      ['10'],
      ['10.5'],
      ['10.50'],
      ['0.01'],
      ['30000000.00'],
      ['9999999999999999.99'], // Đúng 16 chữ số phần nguyên + 2 thập phân (khớp numeric(18,2))
    ])('chấp nhận chuỗi amount hợp lệ "%s"', async (validAmount) => {
      const { errors } = await validateDto(TransferDto, {
        toAccountNumber: '1000000002',
        amount: validAmount,
        description: 'Mo ta hop le',
      });
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['số âm', '-1'],
      ['số âm thập phân', '-0.01'],
      ['3 chữ số thập phân', '1.999'],
      ['ký tự chữ', 'abc'],
      ['ký pháp khoa học', '1e3'],
      ['có khoảng trắng đầu', ' 10'],
      ['chuỗi rỗng', ''],
      ['17 chữ số phần nguyên (vượt numeric(18,2))', '10000000000000000'],
    ])(
      'từ chối chuỗi amount sai định dạng (%s: "%s")',
      async (_label, invalidAmount) => {
        const tfCheck = await validateDto(TransferDto, {
          toAccountNumber: '1000000002',
          amount: invalidAmount,
        });
        expect(tfCheck.errors.length).toBeGreaterThan(0);

        const cashCheck = await validateDto(CashTransactionDto, {
          amount: invalidAmount,
        });
        expect(cashCheck.errors.length).toBeGreaterThan(0);
      },
    );

    it('từ chối description hoặc reason vượt quá 200 ký tự và từ chối trường lạ (forbidNonWhitelisted)', async () => {
      const longText = 'x'.repeat(201);
      const tfErr = await validateDto(TransferDto, {
        toAccountNumber: '1000000002',
        amount: '50000.00',
        description: longText,
      });
      expect(tfErr.errors.length).toBeGreaterThan(0);

      const revErr = await validateDto(ReverseTransactionDto, {
        reason: longText,
      });
      expect(revErr.errors.length).toBeGreaterThan(0);

      const unknownFieldErr = await validateDto(CashTransactionDto, {
        amount: '50000.00',
        hackField: 'injected',
      });
      expect(unknownFieldErr.errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateProfileDto & UpdateAccountAdminDto & UpdateUserStatusDto', () => {
    it.each([
      ['0901234567', '0901234567'],
      ['+84901234567', '+84901234567'],
      ['  0987654321  ', '0987654321'],
      ['', null], // Chuỗi rỗng tự động chuyển về null để xóa số điện thoại
      [null, null],
    ])(
      'UpdateProfileDto chấp nhận và chuẩn hóa phone hợp lệ "%s" -> %s',
      async (rawPhone, expectedPhone) => {
        const { instance, errors } = await validateDto(UpdateProfileDto, {
          fullName: '  Nguyen Van B  ',
          email: '  NEW@BANK.LOCAL ',
          phone: rawPhone,
          currentPassword: 'Password@123',
        });
        expect(errors).toHaveLength(0);
        expect(instance.fullName).toBe('Nguyen Van B');
        expect(instance.email).toBe('new@bank.local');
        expect(instance.phone).toBe(expectedPhone);
      },
    );

    it.each(['12345', '09012345', '09012345678', '+84123', 'abc0901234567'])(
      'UpdateProfileDto từ chối số điện thoại sai định dạng Việt Nam: "%s"',
      async (invalidPhone) => {
        const { errors } = await validateDto(UpdateProfileDto, {
          phone: invalidPhone,
        });
        expect(errors.length).toBeGreaterThan(0);
      },
    );

    it('UpdateAccountAdminDto và UpdateUserStatusDto kiểm tra chặt enum và định dạng holdAmount', async () => {
      const validAccDto = await validateDto(UpdateAccountAdminDto, {
        status: AccountStatus.FROZEN,
        tier: AccountTier.VIP,
        holdAmount: '400000.00',
      });
      expect(validAccDto.errors).toHaveLength(0);

      const invalidAccDto = await validateDto(UpdateAccountAdminDto, {
        status: 'INVALID_STATUS',
        holdAmount: '-100.00',
      });
      expect(invalidAccDto.errors.length).toBeGreaterThan(0);

      const validUserStatus = await validateDto(UpdateUserStatusDto, {
        status: UserStatus.LOCKED,
      });
      expect(validUserStatus.errors).toHaveLength(0);
    });
  });

  describe('Query DTOs (Phân trang, Bộ lọc & Transform)', () => {
    it('TransactionQueryDto và ProfileHistoryQueryDto kiểm tra biên page >= 1 và 1 <= limit <= 100', async () => {
      const validQuery = await validateDto(TransactionQueryDto, {
        page: '2',
        limit: '50',
        direction: TransactionDirection.OUTGOING,
        fromDate: '2026-01-01',
        toDate: '2026-01-31',
        order: SortOrder.ASC,
      });
      expect(validQuery.errors).toHaveLength(0);
      expect(validQuery.instance.page).toBe(2);
      expect(validQuery.instance.limit).toBe(50);

      const pageZero = await validateDto(TransactionQueryDto, { page: 0 });
      expect(pageZero.errors.length).toBeGreaterThan(0);

      const limitOver100 = await validateDto(ProfileHistoryQueryDto, {
        limit: 101,
      });
      expect(limitOver100.errors.length).toBeGreaterThan(0);
    });

    it('AdminUsersQueryDto, AdminTransactionsQueryDto & AdminAuditLogsQueryDto transform đúng includeDeleted và trim chuỗi lọc', async () => {
      const usersQueryTrue = await validateDto(AdminUsersQueryDto, {
        includeDeleted: 'true',
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      expect(usersQueryTrue.errors).toHaveLength(0);
      expect(usersQueryTrue.instance.includeDeleted).toBe(true);

      const usersQueryFalse = await validateDto(AdminUsersQueryDto, {
        includeDeleted: '0',
      });
      expect(usersQueryFalse.errors).toHaveLength(0);
      expect(usersQueryFalse.instance.includeDeleted).toBe(false);

      const txQuery = await validateDto(AdminTransactionsQueryDto, {
        accountNumber: '  1000000001  ',
      });
      expect(txQuery.errors).toHaveLength(0);
      expect(txQuery.instance.accountNumber).toBe('1000000001');

      const auditQuery = await validateDto(AdminAuditLogsQueryDto, {
        entity: '  users  ',
        entityId: '  123  ',
      });
      expect(auditQuery.errors).toHaveLength(0);
      expect(auditQuery.instance.entity).toBe('users');
      expect(auditQuery.instance.entityId).toBe('123');
    });
  });
});
