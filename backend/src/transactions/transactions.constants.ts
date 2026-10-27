/**
 * Các hằng số cấu hình xử lý đồng thời (Concurrency & Locking) cho module Transactions
 */

// Thời gian tối đa một transaction đứng chờ khóa dòng (SELECT ... FOR UPDATE)
// Quá thời gian này PostgreSQL sẽ ném lỗi 55P03 (lock_not_available) -> API trả 503
export const LOCK_TIMEOUT = '5s';

// Mã lỗi PostgreSQL
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_NUMERIC_OVERFLOW = '22003';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_QUERY_CANCELED = '57014';
