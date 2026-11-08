import { AccountTier } from '../../database/entities/account.entity';
import {
  calculateAccountLimits,
  formatCentsToDecimal,
  formatVndCurrency,
  getCurrentVietnamDayRange,
  getVietnamDayStart,
  getVietnamNextDayStart,
  parseDecimalToCents,
} from './date.util';
import { createMockEntityManager } from '../../test-utils/mock-helpers';

describe('date.util — Xử lý số tiền Decimal/BigInt, Định dạng VND, Ngày giờ Việt Nam & Hạn mức', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('parseDecimalToCents & formatCentsToDecimal', () => {
    it.each([
      ['0', 0n, '0.00'],
      ['0.00', 0n, '0.00'],
      ['', 0n, '0.00'],
      ['-1', -100n, '-1.00'],
      ['-0.01', -1n, '-0.01'],
      ['10', 1000n, '10.00'],
      [' 10 ', 1000n, '10.00'],
      ['10.5', 1050n, '10.50'],
      ['0010.25', 1025n, '10.25'],
      ['30000000.01', 3000000001n, '30000000.01'],
      ['9999999999999999.99', 999999999999999999n, '9999999999999999.99'],
    ])(
      'chuyển đổi chính xác chuỗi "%s" -> %s xu -> "%s" mà không bị sai số dấu chấm động',
      (input, expectedCents, expectedFormatted) => {
        const cents = parseDecimalToCents(input);
        expect(cents).toBe(expectedCents);
        expect(formatCentsToDecimal(cents)).toBe(expectedFormatted);
      },
    );
  });

  describe('formatVndCurrency', () => {
    it.each([
      ['0.00', '0 ₫'],
      ['500000.00', '500.000 ₫'],
      ['30000000.00', '30.000.000 ₫'],
      ['30000000.50', '30.000.000,5 ₫'],
      ['30000000.01', '30.000.000,01 ₫'],
      ['-150000.25', '-150.000,25 ₫'],
    ])('định dạng "%s" thành chuỗi tiền tệ VND "%s"', (input, expected) => {
      expect(formatVndCurrency(input)).toBe(expected);
    });
  });

  describe('getVietnamDayStart, getVietnamNextDayStart & getCurrentVietnamDayRange', () => {
    it('trả về đúng mốc 00:00:00+07:00 (tức 17:00:00Z ngày hôm trước) và ngày kế tiếp cách đúng 24 giờ', () => {
      const start = getVietnamDayStart('2026-05-10');
      const nextStart = getVietnamNextDayStart('2026-05-10');

      expect(start.toISOString()).toBe('2026-05-09T17:00:00.000Z');
      expect(nextStart.toISOString()).toBe('2026-05-10T17:00:00.000Z');
      expect(nextStart.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('phân biệt chính xác thời điểm 23:59:59.999 giờ VN (ngày 10/05) và 00:00:00.000 giờ VN (sang ngày 11/05)', () => {
      // 16:59:59.999 UTC = 23:59:59.999 giờ Việt Nam ngày 2026-05-10
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-10T16:59:59.999Z'));

      const rangeBeforeMidnight = getCurrentVietnamDayRange();
      expect(rangeBeforeMidnight.dateString).toBe('2026-05-10');
      expect(rangeBeforeMidnight.start.toISOString()).toBe(
        '2026-05-09T17:00:00.000Z',
      );
      expect(rangeBeforeMidnight.end.toISOString()).toBe(
        '2026-05-10T17:00:00.000Z',
      );

      // 17:00:00.000 UTC = 00:00:00.000 giờ Việt Nam ngày 2026-05-11 (qua đúng vạch nửa đêm)
      jest.setSystemTime(new Date('2026-05-10T17:00:00.000Z'));

      const rangeAtMidnight = getCurrentVietnamDayRange();
      expect(rangeAtMidnight.dateString).toBe('2026-05-11');
      expect(rangeAtMidnight.start.toISOString()).toBe(
        '2026-05-10T17:00:00.000Z',
      );
      expect(rangeAtMidnight.end.toISOString()).toBe(
        '2026-05-11T17:00:00.000Z',
      );
    });
  });

  describe('calculateAccountLimits', () => {
    it('tính đúng hạn mức còn lại cho hạng STANDARD khi usedToday = 0.00 và khi đã dùng một phần', async () => {
      const manager = createMockEntityManager({
        query: jest
          .fn()
          .mockResolvedValueOnce([{ used_today: '0.00' }])
          .mockResolvedValueOnce([{ used_today: '49500000.00' }]),
      });

      const initialLimits = await calculateAccountLimits(
        manager as any,
        'acc-standard-1',
        AccountTier.STANDARD,
      );
      expect(initialLimits).toEqual({
        perTransaction: '30000000.00',
        perDay: '50000000.00',
        usedToday: '0.00',
        remainingToday: '50000000.00',
      });

      const partialLimits = await calculateAccountLimits(
        manager as any,
        'acc-standard-1',
        AccountTier.STANDARD,
      );
      expect(partialLimits).toEqual({
        perTransaction: '30000000.00',
        perDay: '50000000.00',
        usedToday: '49500000.00',
        remainingToday: '500000.00',
      });
    });

    it('tính đúng hạn mức cho hạng VIP (100M/lần, 200M/ngày) và chặn dưới remainingToday = 0.00 nếu usedToday >= perDay', async () => {
      const manager = createMockEntityManager({
        query: jest
          .fn()
          .mockResolvedValueOnce([{ used_today: '210000000.00' }]),
      });

      const vipLimits = await calculateAccountLimits(
        manager as any,
        'acc-vip-1',
        AccountTier.VIP,
      );
      expect(vipLimits).toEqual({
        perTransaction: '100000000.00',
        perDay: '200000000.00',
        usedToday: '210000000.00',
        remainingToday: '0.00',
      });
    });
  });
});
