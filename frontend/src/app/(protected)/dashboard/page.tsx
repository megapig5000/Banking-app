"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/services/api";

interface AccountLimits {
  perTransaction: string;
  perDay: string;
  usedToday: string;
  remainingToday: string;
}

interface Account {
  id: string;
  accountNumber: string;
  balance: string;
  holdAmount: string;
  availableBalance: string;
  status: "ACTIVE" | "FROZEN" | "CLOSED";
  tier: "STANDARD" | "VIP";
  limits: AccountLimits;
  currency: string;
  ownerName: string;
}

export default function DashboardPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAccount = async () => {
      try {
        const res = await api.get("/accounts/me");
        setAccount(res.data);
      } catch (error) {
        console.error("Lỗi tải tài khoản", error);
      } finally {
        setLoading(false);
      }
    };
    void fetchAccount();
  }, []);

  if (loading) {
    return (
      <div className="p-6 text-center text-gray-600">
        Đang tải thông tin tài khoản...
      </div>
    );
  }
  if (!account) {
    return (
      <div className="p-6 text-center text-red-600">
        Không tìm thấy tài khoản ngân hàng.
      </div>
    );
  }

  const formatMoney = (val: string) =>
    new Intl.NumberFormat("vi-VN").format(parseFloat(val || "0"));

  const holdValue = parseFloat(account.holdAmount || "0");
  const perDayNum = parseFloat(account.limits?.perDay || "1");
  const usedTodayNum = parseFloat(account.limits?.usedToday || "0");
  const usedPercent =
    perDayNum > 0
      ? Math.min(100, Math.round((usedTodayNum / perDayNum) * 100))
      : 0;

  const renderStatusBadge = (status: Account["status"]) => {
    if (status === "ACTIVE") {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
          ACTIVE — Đang hoạt động
        </span>
      );
    }
    if (status === "FROZEN") {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
          FROZEN — Đang đóng băng
        </span>
      );
    }
    return (
      <span className="px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-300">
        CLOSED — Đã đóng
      </span>
    );
  };

  const renderTierBadge = (tier: Account["tier"]) => {
    if (tier === "VIP") {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-800 border border-purple-300">
          Hạng VIP
        </span>
      );
    }
    return (
      <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
        Hạng STANDARD (Tiêu chuẩn)
      </span>
    );
  };

  return (
    <div className="max-w-3xl mx-auto mt-6 space-y-6 px-4 sm:px-0">
      {/* Banner cảnh báo rõ khi tài khoản bị FROZEN hoặc CLOSED */}
      {account.status === "FROZEN" && (
        <div
          role="alert"
          className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-md shadow-sm"
        >
          <p className="font-bold text-amber-900">
            Cảnh báo: Tài khoản của bạn đang bị tạm đóng băng (FROZEN)
          </p>
          <p className="text-sm text-amber-800 mt-1">
            Tài khoản hiện không thể thực hiện giao dịch nạp tiền, rút tiền hoặc
            chuyển khoản (cả chiều đi lẫn chiều đến). Vui lòng liên hệ Quản trị
            viên để được hỗ trợ mở băng.
          </p>
        </div>
      )}

      {account.status === "CLOSED" && (
        <div
          role="alert"
          className="bg-red-50 border-l-4 border-red-600 p-4 rounded-md shadow-sm"
        >
          <p className="font-bold text-red-900">
            Thông báo: Tài khoản ngân hàng này đã đóng (CLOSED)
          </p>
          <p className="text-sm text-red-800 mt-1">
            Tài khoản ở trạng thái kết thúc và không thể thực hiện bất kỳ giao
            dịch nào.
          </p>
        </div>
      )}

      {/* Thẻ thông tin tài khoản & Số dư khả dụng */}
      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-6 border-b pb-3">
          <h2 className="text-2xl font-bold text-gray-800">
            Thông tin tài khoản
          </h2>
          <div className="flex items-center gap-2">
            {renderTierBadge(account.tier)}
            {renderStatusBadge(account.status)}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex justify-between items-center bg-gray-50 p-4 rounded-md">
            <span className="text-gray-600 font-medium">Chủ tài khoản:</span>
            <span className="text-lg font-semibold text-gray-900">
              {account.ownerName}
            </span>
          </div>

          <div className="flex justify-between items-center bg-gray-50 p-4 rounded-md">
            <span className="text-gray-600 font-medium">Số tài khoản:</span>
            <span className="text-lg font-bold text-blue-600 tracking-wider">
              {account.accountNumber}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
              <p className="text-xs text-gray-500 uppercase font-semibold">
                Số dư sổ sách (Balance)
              </p>
              <p className="text-lg font-bold text-gray-800 mt-1">
                {formatMoney(account.balance)} {account.currency}
              </p>
            </div>

            <div
              className={`p-4 rounded-md border ${
                holdValue > 0
                  ? "bg-amber-50 border-amber-200"
                  : "bg-gray-50 border-gray-200"
              }`}
            >
              <p className="text-xs text-gray-500 uppercase font-semibold">
                Đang phong tỏa (Hold)
              </p>
              <p
                className={`text-lg font-bold mt-1 ${
                  holdValue > 0 ? "text-amber-700" : "text-gray-700"
                }`}
              >
                {formatMoney(account.holdAmount)} {account.currency}
              </p>
            </div>

            <div className="bg-emerald-50 p-4 rounded-md border border-emerald-200">
              <p className="text-xs text-emerald-700 uppercase font-semibold">
                Số dư khả dụng
              </p>
              <p className="text-xl font-bold text-emerald-700 mt-1">
                {formatMoney(account.availableBalance)} {account.currency}
              </p>
            </div>
          </div>
        </div>

        {/* Khối Hạn mức giao dịch và Thanh tiến độ "Đã dùng hôm nay" */}
        {account.limits && (
          <div className="mt-6 pt-5 border-t border-gray-200">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="text-base font-bold text-gray-800">
                Hạn mức chuyển khoản & rút tiền hôm nay (Giờ Việt Nam)
              </h3>
              <span className="text-xs text-gray-500">
                Tối đa mỗi giao dịch:{" "}
                <strong className="text-gray-800">
                  {formatMoney(account.limits.perTransaction)}{" "}
                  {account.currency}
                </strong>
              </span>
            </div>

            <div className="bg-slate-50 p-4 rounded-md border border-slate-200 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">
                  Đã dùng hôm nay:{" "}
                  <strong className="text-gray-900">
                    {formatMoney(account.limits.usedToday)} {account.currency}
                  </strong>{" "}
                  / {formatMoney(account.limits.perDay)} {account.currency}
                </span>
                <span className="font-semibold text-blue-700">
                  {usedPercent}%
                </span>
              </div>

              {/* Thanh tiến độ (Progress Bar) */}
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${
                    usedPercent >= 90
                      ? "bg-red-600"
                      : usedPercent >= 70
                        ? "bg-amber-500"
                        : "bg-blue-600"
                  }`}
                  style={{ width: `${usedPercent}%` }}
                />
              </div>

              <div className="flex justify-between items-center text-xs text-gray-600 pt-1">
                <span>
                  Hạn mức ngày còn lại:{" "}
                  <strong className="text-emerald-700 text-sm">
                    {formatMoney(account.limits.remainingToday)}{" "}
                    {account.currency}
                  </strong>
                </span>
                <span className="italic text-gray-500">
                  (Miễn hạn mức cho Nạp tiền & Hoàn tiền)
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Các nút điều hướng nhanh */}
        <div className="mt-6 pt-4 border-t grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Link
            href="/cash"
            className="text-center bg-emerald-600 text-white py-2.5 px-3 rounded-md text-sm font-medium hover:bg-emerald-700 transition"
          >
            Nạp / Rút tiền
          </Link>
          <Link
            href="/transfer"
            className="text-center bg-blue-600 text-white py-2.5 px-3 rounded-md text-sm font-medium hover:bg-blue-700 transition"
          >
            Chuyển khoản
          </Link>
          <Link
            href="/transactions"
            className="text-center bg-gray-100 text-gray-800 py-2.5 px-3 rounded-md text-sm font-medium hover:bg-gray-200 transition border border-gray-300"
          >
            Lịch sử GD
          </Link>
          <Link
            href="/profile"
            className="text-center bg-indigo-50 text-indigo-700 py-2.5 px-3 rounded-md text-sm font-medium hover:bg-indigo-100 transition border border-indigo-200"
          >
            Hồ sơ cá nhân
          </Link>
        </div>
      </div>
    </div>
  );
}
