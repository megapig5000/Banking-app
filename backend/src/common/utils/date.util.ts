import { EntityManager } from 'typeorm';
import { AccountTier } from '../../database/entities/account.entity';
import { ACCOUNT_TIER_LIMITS } from '../../transactions/transactions.constants';

export interface AccountLimitsSummary {
  perTransaction: string;
  perDay: string;
  usedToday: string;
  remainingToday: string;
}

/**
 * Trả về mốc 00:00:00.000 theo múi giờ Việt Nam (UTC+7) của chuỗi ngày YYYY-MM-DD
 */
export function getVietnamDayStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000+07:00`);
}

/**
 * Trả về mốc 00:00:00.000 của ngày kế tiếp theo múi giờ Việt Nam (UTC+7)
 * Dùng cho điều kiện lọc created_at < toDateNextDayStart
 */
export function getVietnamNextDayStart(dateStr: string): Date {
  const start = getVietnamDayStart(dateStr);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Trả về khoảng [start, end) của ngày hiện tại theo múi giờ Việt Nam (UTC+7)
 */
export function getCurrentVietnamDayRange(now: Date = new Date()): {
  start: Date;
  end: Date;
  dateString: string;
} {
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const dateString = vnTime.toISOString().slice(0, 10);
  return {
    start: getVietnamDayStart(dateString),
    end: getVietnamNextDayStart(dateString),
    dateString,
  };
}

/**
 * Chuyển chuỗi số thập phân (tối đa 2 chữ số sau dấu chấm) sang số nguyên BigInt (đơn vị xu)
 * Tuyệt đối không dùng Number/parseFloat để tránh sai số dấu chấm động.
 */
export function parseDecimalToCents(decimalStr: string): bigint {
  const trimmed = (decimalStr || '0').trim();
  const isNegative = trimmed.startsWith('-');
  const normalized = isNegative ? trimmed.slice(1) : trimmed;
  const [intPart = '0', fracPart = ''] = normalized.split('.');
  const paddedFrac = (fracPart + '00').slice(0, 2);
  const cents = BigInt(intPart || '0') * 100n + BigInt(paddedFrac);
  return isNegative ? -cents : cents;
}

/**
 * Chuyển số nguyên BigInt (đơn vị xu) về lại chuỗi decimal 2 chữ số thập phân (VD: "500000.00")
 */
export function formatCentsToDecimal(cents: bigint): string {
  const isNegative = cents < 0n;
  const absCents = isNegative ? -cents : cents;
  const intPart = absCents / 100n;
  const fracPart = (absCents % 100n).toString().padStart(2, '0');
  return `${isNegative ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

/**
 * Định dạng chuỗi decimal sang chuỗi tiền tệ VND thân thiện bằng Intl.NumberFormat('vi-VN')
 * (Ví dụ: "50000000.00" -> "50.000.000 ₫", "30000000.01" -> "30.000.000,01 ₫")
 */
export function formatVndCurrency(decimalStr: string): string {
  const cents = parseDecimalToCents(decimalStr);
  const isNegative = cents < 0n;
  const absCents = isNegative ? -cents : cents;
  const intPart = absCents / 100n;
  const fracCents = absCents % 100n;

  const formattedInt = new Intl.NumberFormat('vi-VN').format(intPart);
  const sign = isNegative ? '-' : '';

  if (fracCents === 0n) {
    return `${sign}${formattedInt} ₫`;
  }

  const fracStr = fracCents.toString().padStart(2, '0').replace(/0+$/, '');
  return `${sign}${formattedInt},${fracStr} ₫`;
}

/**
 * Tính toán hạn mức và tổng số tiền đã dùng hôm nay (usedToday) của một tài khoản (Bài 5.1):
 * - Chỉ tính các giao dịch TRANSFER và WITHDRAW đang ở trạng thái COMPLETED
 *   có from_account_id = accountId.
 * - Không tính DEPOSIT, REVERSAL, giao dịch FAILED, hoặc giao dịch gốc đã REVERSED.
 * - Mốc ngày hôm nay tính theo giờ Việt Nam (Asia/Ho_Chi_Minh) bằng đồng hồ của PostgreSQL.
 */
export async function calculateAccountLimits(
  manager: EntityManager,
  accountId: string,
  tier: AccountTier,
): Promise<AccountLimitsSummary> {
  const tierConfig =
    ACCOUNT_TIER_LIMITS[tier] ?? ACCOUNT_TIER_LIMITS[AccountTier.STANDARD];

  const rows: Array<{ used_today: string }> = await manager.query(
    `
    SELECT COALESCE(SUM(t.amount), 0)::numeric(18,2)::text AS used_today
    FROM "transactions" t
    WHERE t.from_account_id = $1
      AND t.type IN ('TRANSFER', 'WITHDRAW')
      AND t.status = 'COMPLETED'
      AND t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')
      AND t.created_at < ((date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') + INTERVAL '1 day') AT TIME ZONE 'Asia/Ho_Chi_Minh')
    `,
    [accountId],
  );

  const usedTodayStr = rows[0]?.used_today ?? '0.00';
  const perDayCents = parseDecimalToCents(tierConfig.perDay);
  const usedTodayCents = parseDecimalToCents(usedTodayStr);
  const remainingCents =
    perDayCents > usedTodayCents ? perDayCents - usedTodayCents : 0n;

  return {
    perTransaction: tierConfig.perTransaction,
    perDay: tierConfig.perDay,
    usedToday: formatCentsToDecimal(usedTodayCents),
    remainingToday: formatCentsToDecimal(remainingCents),
  };
}
