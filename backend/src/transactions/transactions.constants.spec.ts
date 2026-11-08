import { HttpStatus } from '@nestjs/common';
import { AccountTier } from '../database/entities/account.entity';
import { TransactionStatus } from '../database/entities/transaction.entity';
import { parseDecimalToCents } from '../common/utils/date.util';
import {
  ACCOUNT_TIER_LIMITS,
  ALLOWED_STATUS_TRANSITIONS,
  canTransition,
  FAILURE_CODE_MAP,
  TransactionFailureCode,
} from './transactions.constants';

describe('transactions.constants — State Machine 36 cặp, Bảng mã lỗi & Bảng hạn mức', () => {
  describe('canTransition & ALLOWED_STATUS_TRANSITIONS (Ma trận 36 cặp trạng thái)', () => {
    const allStatuses = Object.values(TransactionStatus);

    const validEdges = new Set<string>([
      `${TransactionStatus.INITIATED}->${TransactionStatus.PENDING_OTP}`,
      `${TransactionStatus.INITIATED}->${TransactionStatus.PROCESSING}`,
      `${TransactionStatus.PENDING_OTP}->${TransactionStatus.PROCESSING}`,
      `${TransactionStatus.PENDING_OTP}->${TransactionStatus.FAILED}`,
      `${TransactionStatus.PROCESSING}->${TransactionStatus.COMPLETED}`,
      `${TransactionStatus.PROCESSING}->${TransactionStatus.FAILED}`,
      `${TransactionStatus.COMPLETED}->${TransactionStatus.REVERSED}`,
    ]);

    const allPairs: Array<[TransactionStatus, TransactionStatus, boolean]> = [];
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        allPairs.push([from, to, validEdges.has(`${from}->${to}`)]);
      }
    }

    it('có đúng 6 trạng thái và 36 cặp chuyển trạng thái trong không gian trạng thái', () => {
      expect(allStatuses).toHaveLength(6);
      expect(allPairs).toHaveLength(36);
    });

    it.each(allPairs)(
      'chuyển trạng thái %s -> %s trả về %s',
      (from, to, expected) => {
        expect(canTransition(from, to)).toBe(expected);
      },
    );

    it('FAILED và REVERSED là trạng thái kết thúc (terminal states) không có cạnh đi ra', () => {
      expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.FAILED]).toEqual([]);
      expect(ALLOWED_STATUS_TRANSITIONS[TransactionStatus.REVERSED]).toEqual(
        [],
      );
    });
  });

  describe('TransactionFailureCode & FAILURE_CODE_MAP', () => {
    const allFailureCodes = Object.values(TransactionFailureCode);

    it('mọi mã lỗi trong TransactionFailureCode đều được định nghĩa đầy đủ trong FAILURE_CODE_MAP', () => {
      expect(allFailureCodes.length).toBeGreaterThanOrEqual(13);

      for (const code of allFailureCodes) {
        const def = FAILURE_CODE_MAP[code];
        expect(def).toBeDefined();
        expect([
          HttpStatus.UNPROCESSABLE_ENTITY,
          HttpStatus.SERVICE_UNAVAILABLE,
          HttpStatus.INTERNAL_SERVER_ERROR,
        ]).toContain(def.httpStatus);
        expect(typeof def.message).toBe('string');
        expect(def.message.trim().length).toBeGreaterThan(5);
      }
    });

    it('4 mã lỗi trạng thái tài khoản (FROZEN/CLOSED) và 2 mã lỗi hạn mức đều ánh xạ sang HTTP 422', () => {
      const codes422 = [
        TransactionFailureCode.SOURCE_ACCOUNT_FROZEN,
        TransactionFailureCode.SOURCE_ACCOUNT_CLOSED,
        TransactionFailureCode.DESTINATION_ACCOUNT_FROZEN,
        TransactionFailureCode.DESTINATION_ACCOUNT_CLOSED,
        TransactionFailureCode.LIMIT_PER_TRANSACTION_EXCEEDED,
        TransactionFailureCode.LIMIT_PER_DAY_EXCEEDED,
        TransactionFailureCode.INSUFFICIENT_BALANCE,
        TransactionFailureCode.REVERSAL_INSUFFICIENT_BALANCE,
      ];

      for (const code of codes422) {
        expect(FAILURE_CODE_MAP[code].httpStatus).toBe(
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    });
  });

  describe('ACCOUNT_TIER_LIMITS (Bảng hạn mức theo hạng tài khoản)', () => {
    it('định nghĩa đúng ngưỡng cho STANDARD (30M/lần, 50M/ngày) và VIP (100M/lần, 200M/ngày)', () => {
      expect(ACCOUNT_TIER_LIMITS[AccountTier.STANDARD]).toEqual({
        perTransaction: '30000000.00',
        perDay: '50000000.00',
      });
      expect(ACCOUNT_TIER_LIMITS[AccountTier.VIP]).toEqual({
        perTransaction: '100000000.00',
        perDay: '200000000.00',
      });

      // Hạn mức VIP phải lớn hơn STANDARD và hạn mức ngày phải lớn hơn hạn mức mỗi lần
      expect(
        parseDecimalToCents(
          ACCOUNT_TIER_LIMITS[AccountTier.VIP].perTransaction,
        ),
      ).toBeGreaterThan(
        parseDecimalToCents(
          ACCOUNT_TIER_LIMITS[AccountTier.STANDARD].perTransaction,
        ),
      );
      expect(
        parseDecimalToCents(ACCOUNT_TIER_LIMITS[AccountTier.STANDARD].perDay),
      ).toBeGreaterThan(
        parseDecimalToCents(
          ACCOUNT_TIER_LIMITS[AccountTier.STANDARD].perTransaction,
        ),
      );
    });
  });
});
