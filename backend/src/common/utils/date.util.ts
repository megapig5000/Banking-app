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
