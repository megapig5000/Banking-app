/**
 * Thời hạn sống mặc định của một Idempotency-Key (24 giờ)
 */
export const IDEMPOTENCY_TTL_HOURS = 24;

export type IdempotencyOperation =
  'TRANSFER' | 'DEPOSIT' | 'WITHDRAW' | 'REVERSE';

export type IdempotencyHashPayload =
  | {
      operation: 'TRANSFER';
      toAccountNumber: string;
      amount: string;
      description: string | null;
    }
  | {
      operation: 'DEPOSIT';
      amount: string;
      description: string | null;
    }
  | {
      operation: 'WITHDRAW';
      amount: string;
      description: string | null;
    }
  | {
      operation: 'REVERSE';
      originalTransactionId: string;
      reason: string | null;
    };
