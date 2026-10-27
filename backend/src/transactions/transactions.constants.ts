/**
 * Các hằng số cấu hình xử lý đồng thời (Concurrency & Locking) cho module Transactions
 */

export const LOCK_TIMEOUT = '5s';

// Cấu hình cho Optimistic Locking (Bài 1.3 - Nhánh thử nghiệm)
export const MAX_OPTIMISTIC_RETRIES = 5;
export const RETRY_DELAY_MIN_MS = 10;
export const RETRY_DELAY_MAX_MS = 50;

// Mã lỗi PostgreSQL
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_NUMERIC_OVERFLOW = '22003';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_QUERY_CANCELED = '57014';