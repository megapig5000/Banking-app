import {
  normalizeAuditDecimal,
  pickAllowedAccountAuditSnapshot,
  pickAllowedUserAuditSnapshot,
} from './audit.constants';
import {
  getRequestContextSnapshot,
  MAX_IP_ADDRESS_LENGTH,
  MAX_USER_AGENT_LENGTH,
  requestContextStorage,
} from '../common/context/request-context';
import { RequestContextMiddleware } from '../common/context/request-context.middleware';
import { buildMockAccount, buildMockUser } from '../test-utils/mock-helpers';
import {
  AccountStatus,
  AccountTier,
} from '../database/entities/account.entity';
import { UserRole, UserStatus } from '../database/entities/user.entity';

describe('audit.constants & request-context — Snapshot Whitelist & AsyncLocalStorage Context', () => {
  describe('pickAllowedUserAuditSnapshot', () => {
    it('trả về null khi đầu vào là null hoặc undefined', () => {
      expect(pickAllowedUserAuditSnapshot(null)).toBeNull();
      expect(pickAllowedUserAuditSnapshot(undefined)).toBeNull();
    });

    it('chỉ trích xuất đúng 5 trường trong danh sách trắng (fullName, email, phone, role, status) và tuyệt đối loại bỏ password_hash', () => {
      const user = buildMockUser({
        full_name: 'Nguyen Van A',
        email: 'user1@bank.local',
        phone: '0901234567',
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
        password_hash: '$2b$10$supersecretpasswordhash',
      });

      const snapshot = pickAllowedUserAuditSnapshot(user);
      expect(snapshot).toEqual({
        fullName: 'Nguyen Van A',
        email: 'user1@bank.local',
        phone: '0901234567',
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
      });
      expect((snapshot as any).password_hash).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain('supersecret');
    });
  });

  describe('normalizeAuditDecimal & pickAllowedAccountAuditSnapshot', () => {
    it('normalizeAuditDecimal xử lý null/undefined và chuẩn hóa số thập phân về 2 chữ số', () => {
      expect(normalizeAuditDecimal(null)).toBeNull();
      expect(normalizeAuditDecimal(undefined)).toBeNull();
      expect(normalizeAuditDecimal('0')).toBe('0.00');
      expect(normalizeAuditDecimal('400000.5')).toBe('400000.50');
      expect(normalizeAuditDecimal('-10')).toBe('-10.00');
    });

    it('pickAllowedAccountAuditSnapshot trả về null khi rỗng và chỉ trích xuất status, tier, holdAmount (không lấy balance)', () => {
      expect(pickAllowedAccountAuditSnapshot(null)).toBeNull();

      const account = buildMockAccount({
        balance: '9000000.00',
        hold_amount: '400000',
        status: AccountStatus.FROZEN,
        tier: AccountTier.VIP,
      });

      const snapshot = pickAllowedAccountAuditSnapshot(account);
      expect(snapshot).toEqual({
        status: AccountStatus.FROZEN,
        tier: AccountTier.VIP,
        holdAmount: '400000.00',
      });
      expect((snapshot as any).balance).toBeUndefined();
    });
  });

  describe('RequestContextMiddleware & getRequestContextSnapshot', () => {
    it('trả về toàn bộ trường null khi gọi ngoài ngữ cảnh request (ví dụ trong seed hoặc cron job)', () => {
      expect(getRequestContextSnapshot()).toEqual({
        actorId: null,
        ipAddress: null,
        userAgent: null,
      });
    });

    it('mở ngữ cảnh qua RequestContextMiddleware và đọc trễ (lazy read) req.user, ip, user-agent (kể cả cắt ngắn chuỗi quá dài)', () => {
      const middleware = new RequestContextMiddleware();
      const longUa = 'Mozilla/5.0-' + 'X'.repeat(300);
      const longIp = '192.168.1.1-' + '9'.repeat(100);

      const mockReq: any = {
        ip: `  ${longIp}  `,
        headers: {
          'user-agent': [longUa, 'Second-Agent'],
        },
      };

      let capturedSnapshot: any = null;

      middleware.use(mockReq, {} as any, () => {
        // Giả lập Guard chạy sau Middleware gán req.user
        mockReq.user = { id: 'actor-uuid-123' };
        capturedSnapshot = getRequestContextSnapshot();
      });

      expect(capturedSnapshot).not.toBeNull();
      expect(capturedSnapshot.actorId).toBe('actor-uuid-123');
      expect(capturedSnapshot.ipAddress).toHaveLength(MAX_IP_ADDRESS_LENGTH);
      expect(capturedSnapshot.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
    });

    it('fallback sang req.socket.remoteAddress khi req.ip rỗng', () => {
      const mockReq: any = {
        ip: '   ',
        socket: { remoteAddress: ' 10.0.0.5 ' },
        headers: {},
      };

      requestContextStorage.run({ req: mockReq }, () => {
        const snapshot = getRequestContextSnapshot();
        expect(snapshot.actorId).toBeNull();
        expect(snapshot.ipAddress).toBe('10.0.0.5');
        expect(snapshot.userAgent).toBeNull();
      });
    });
  });
});
