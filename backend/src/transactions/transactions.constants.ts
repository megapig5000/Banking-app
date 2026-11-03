import { HttpStatus } from '@nestjs/common';
import { TransactionStatus } from '../database/entities/transaction.entity';

/**
 * Các hằng số cấu hình xử lý đồng thời (Concurrency, Locking & Deadlock Retry)
 * và Vòng đời giao dịch (State Machine & Failure Codes - Module 3B)
 */

// Thời gian tối đa một transaction đứng chờ khóa dòng (SELECT ... FOR UPDATE)
// Quá thời gian này PostgreSQL sẽ ném lỗi 55P03 (lock_not_available) -> API trả 503
export const LOCK_TIMEOUT = '5s';

// Số lần tự động thử lại tối đa khi PostgreSQL phát hiện Deadlock (40P01)
export const MAX_DEADLOCK_RETRIES = 3;
export const RETRY_DELAY_MIN_MS = 10;
export const RETRY_DELAY_MAX_MS = 50;

// Ngưỡng thời gian (giây) để coi một giao dịch PROCESSING là bị "treo" (Bài 5.3)
export const STUCK_AFTER_SECONDS = 120;

// Mã lỗi PostgreSQL
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_NUMERIC_OVERFLOW = '22003';
export const PG_LOCK_NOT_AVAILABLE = '55P03';
export const PG_QUERY_CANCELED = '57014';
export const PG_DEADLOCK_DETECTED = '40P01';

/**
 * Bảng chuyển trạng thái hợp lệ duy nhất của Vòng đời giao dịch (Bài 3.2 & 5.3)
 * - INITIATED    -> PENDING_OTP, PROCESSING
 * - PENDING_OTP  -> PROCESSING, FAILED
 * - PROCESSING   -> COMPLETED, FAILED
 * - COMPLETED    -> REVERSED
 * - FAILED       -> (trạng thái kết thúc, không đi đâu nữa)
 * - REVERSED     -> (trạng thái kết thúc, không đi đâu nữa)
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = {
  [TransactionStatus.INITIATED]: [
    TransactionStatus.PENDING_OTP,
    TransactionStatus.PROCESSING,
  ],
  [TransactionStatus.PENDING_OTP]: [
    TransactionStatus.PROCESSING,
    TransactionStatus.FAILED,
  ],
  [TransactionStatus.PROCESSING]: [
    TransactionStatus.COMPLETED,
    TransactionStatus.FAILED,
  ],
  [TransactionStatus.COMPLETED]: [TransactionStatus.REVERSED],
  [TransactionStatus.FAILED]: [],
  [TransactionStatus.REVERSED]: [],
};

/**
 * Hàm thuần kiểm tra cạnh chuyển trạng thái từ `from` sang `to` có hợp lệ hay không.
 */
export function canTransition(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  const allowedTargets = ALLOWED_STATUS_TRANSITIONS[from];
  return Array.isArray(allowedTargets) && allowedTargets.includes(to);
}

/**
 * Mã lý do thất bại được lưu vào cột transactions.failure_code khi status = FAILED
 */
export enum TransactionFailureCode {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  DESTINATION_UNAVAILABLE = 'DESTINATION_UNAVAILABLE',
  AMOUNT_OVERFLOW = 'AMOUNT_OVERFLOW',
  REVERSAL_INSUFFICIENT_BALANCE = 'REVERSAL_INSUFFICIENT_BALANCE',
  SERVER_BUSY = 'SERVER_BUSY',
  TIMEOUT = 'TIMEOUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface FailureCodeDefinition {
  httpStatus: number;
  message: string;
}

/**
 * Bảng ánh xạ duy nhất từ failure_code sang HTTP status và thông báo lỗi trả cho client.
 * Dùng chung cho cả lúc giao dịch thất bại lần đầu (Pha C) và khi Replay một giao dịch FAILED.
 */
export const FAILURE_CODE_MAP: Readonly<
  Record<TransactionFailureCode, FailureCodeDefinition>
> = {
  [TransactionFailureCode.INSUFFICIENT_BALANCE]: {
    httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Không đủ số dư khả dụng',
  },
  [TransactionFailureCode.DESTINATION_UNAVAILABLE]: {
    httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Tài khoản đích đang bị khóa, không thể nhận tiền',
  },
  [TransactionFailureCode.AMOUNT_OVERFLOW]: {
    httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Số dư tài khoản vượt quá giới hạn cho phép',
  },
  [TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE]: {
    httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Tài khoản nhận không đủ số dư để thực hiện hoàn tiền',
  },
  [TransactionFailureCode.SERVER_BUSY]: {
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Hệ thống đang bận, vui lòng thử lại',
  },
  [TransactionFailureCode.TIMEOUT]: {
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Giao dịch bị quá thời gian xử lý, vui lòng thử lại',
  },
  [TransactionFailureCode.INTERNAL_ERROR]: {
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Lỗi hệ thống khi thực hiện giao dịch',
  },
};
