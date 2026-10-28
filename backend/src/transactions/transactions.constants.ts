/**
 * Các hằng số cấu hình xử lý đồng thời (Concurrency, Locking & Deadlock Retry)
 * cho module Transactions
 */

// Thời gian tối đa một transaction đứng chờ khóa dòng (SELECT ... FOR UPDATE)
// Quá thời gian này PostgreSQL sẽ ném lỗi 55P03 (lock_not_available) -> API trả 503
export const LOCK_TIMEOUT = '5s';

// Số lần tự động thử lại tối đa khi PostgreSQL phát hiện Deadlock (40P01)
export const MAX_DEADLOCK_RETRIES = 3;
export const RETRY_DELAY_MIN_MS = 10;
export const RETRY_DELAY_MAX_MS = 50;

// Mã lỗi PostgreSQL
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_NUMERIC_OVERFLOW = '22003';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_QUERY_CANCELED = '57014';
export const PG_DEADLOCK_DETECTED = '40P01';
