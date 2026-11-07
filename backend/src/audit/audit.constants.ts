import type { User } from '../database/entities/user.entity';
import type { Account } from '../database/entities/account.entity';

export enum AuditAction {
  USER_STATUS_CHANGED = 'USER_STATUS_CHANGED',
  USER_UPDATED = 'USER_UPDATED',
  USER_SOFT_DELETED = 'USER_SOFT_DELETED',
  ACCOUNT_UPDATED = 'ACCOUNT_UPDATED',
  AUTH_LOGIN_SUCCESS = 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILED = 'AUTH_LOGIN_FAILED',
  TRANSACTION_REVERSED = 'TRANSACTION_REVERSED',
}

export enum AuditEntity {
  USERS = 'users',
  ACCOUNTS = 'accounts',
  TRANSACTIONS = 'transactions',
}

/**
 * Danh sách trắng duy nhất các trường của User được phép đưa vào before_data / after_data.
 * Tuyệt đối KHÔNG bao giờ chứa password_hash.
 */
export const ALLOWED_USER_AUDIT_FIELDS = [
  'fullName',
  'email',
  'phone',
  'role',
  'status',
] as const;

export type AllowedUserAuditField = (typeof ALLOWED_USER_AUDIT_FIELDS)[number];

export type AllowedUserAuditSnapshot = Record<AllowedUserAuditField, any>;

/**
 * Trích xuất bản chụp an toàn (chỉ gồm các trường trong danh sách cho phép) từ thực thể User.
 */
export function pickAllowedUserAuditSnapshot(
  user: Partial<User> | null | undefined,
): AllowedUserAuditSnapshot | null {
  if (!user) {
    return null;
  }
  return {
    fullName: user.full_name ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role ?? null,
    status: user.status ?? null,
  };
}

/**
 * Danh sách trắng duy nhất các trường của Account được phép đưa vào before_data / after_data (Bài 5.2).
 */
export const ALLOWED_ACCOUNT_AUDIT_FIELDS = [
  'status',
  'tier',
  'holdAmount',
] as const;

export type AllowedAccountAuditField =
  (typeof ALLOWED_ACCOUNT_AUDIT_FIELDS)[number];

export type AllowedAccountAuditSnapshot = Record<AllowedAccountAuditField, any>;

/**
 * Chuẩn hóa chuỗi số thập phân về đúng 2 chữ số sau dấu chấm (VD: "0" -> "0.00")
 * để so sánh chính xác tuyệt đối khi chụp snapshot của hold_amount.
 */
export function normalizeAuditDecimal(
  val: string | number | null | undefined,
): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = String(val).trim();
  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;
  const [rawInt = '0', rawFrac = ''] = unsigned.split('.');
  const normalizedInt = rawInt.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFrac = (rawFrac + '00').slice(0, 2);
  return `${isNegative ? '-' : ''}${normalizedInt}.${normalizedFrac}`;
}

/**
 * Trích xuất bản chụp an toàn (status, tier, holdAmount) từ thực thể Account.
 */
export function pickAllowedAccountAuditSnapshot(
  account: Partial<Account> | null | undefined,
): AllowedAccountAuditSnapshot | null {
  if (!account) {
    return null;
  }
  return {
    status: account.status ?? null,
    tier: account.tier ?? null,
    holdAmount: normalizeAuditDecimal(account.hold_amount),
  };
}
