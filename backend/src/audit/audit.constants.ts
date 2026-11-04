import type { User } from '../database/entities/user.entity';

export enum AuditAction {
  USER_STATUS_CHANGED = 'USER_STATUS_CHANGED',
  USER_UPDATED = 'USER_UPDATED',
  AUTH_LOGIN_SUCCESS = 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILED = 'AUTH_LOGIN_FAILED',
  TRANSACTION_REVERSED = 'TRANSACTION_REVERSED',
}

export enum AuditEntity {
  USERS = 'users',
  TRANSACTIONS = 'transactions',
}

/**
 * Danh sách trắng duy nhất các trường của User được phép đưa vào before_data / after_data.
 * Tuyệt đối KHÔNG bao giờ chứa password_hash.
 */
export const ALLOWED_USER_AUDIT_FIELDS = [
  'fullName',
  'email',
  'role',
  'status',
] as const;

export type AllowedUserAuditField = (typeof ALLOWED_USER_AUDIT_FIELDS)[number];

export type AllowedUserAuditSnapshot = Record<AllowedUserAuditField, any>;

/**
 * Trích xuất bản chụp an toàn (chỉ gồm 4 trường trong danh sách cho phép) từ thực thể User.
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
    role: user.role ?? null,
    status: user.status ?? null,
  };
}
