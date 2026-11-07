"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { api, submitIdempotentTransaction } from "@/services/api";

type CashTab = "deposit" | "withdraw";

interface AccountLimits {
  perTransaction: string;
  perDay: string;
  usedToday: string;
  remainingToday: string;
}

interface AccountInfo {
  accountNumber: string;
  balance: string;
  holdAmount: string;
  availableBalance: string;
  status: "ACTIVE" | "FROZEN" | "CLOSED";
  tier: "STANDARD" | "VIP";
  limits?: AccountLimits;
  currency: string;
}

interface TransactionItem {
  id: string;
  amount: string;
  type: "TRANSFER" | "DEPOSIT" | "WITHDRAW" | "REVERSAL";
  status:
    | "INITIATED"
    | "PENDING_OTP"
    | "PROCESSING"
    | "COMPLETED"
    | "FAILED"
    | "REVERSED";
  description: string | null;
  createdAt: string;
  direction: "incoming" | "outgoing";
  counterpartyAccountNumber: string | null;
}

export default function CashPage() {
  const [activeTab, setActiveTab] = useState<CashTab>("deposit");
  const [formData, setFormData] = useState({
    amount: "",
    description: "",
  });
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => uuidv4());
  const [loading, setLoading] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info" | "warning";
    text: string;
  } | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<
    TransactionItem[]
  >([]);

  const inFlightRef = useRef(false);

  const fetchAccountAndRecentTransactions = useCallback(async () => {
    try {
      const [accRes, txRes] = await Promise.all([
        api.get("/accounts/me"),
        api.get("/transactions?page=1&limit=5&order=desc"),
      ]);
      setAccount(accRes.data);
      setRecentTransactions(txRes.data.data || []);
    } catch (err) {
      console.error("Lỗi tải dữ liệu tài khoản/lịch sử:", err);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const loadInitialData = async () => {
      try {
        const [accRes, txRes] = await Promise.all([
          api.get("/accounts/me"),
          api.get("/transactions?page=1&limit=5&order=desc"),
        ]);
        if (!active) return;
        setAccount(accRes.data);
        setRecentTransactions(txRes.data.data || []);
      } catch (err) {
        console.error("Lỗi tải dữ liệu tài khoản/lịch sử:", err);
      }
    };
    void loadInitialData();
    return () => {
      active = false;
    };
  }, []);

  const handleTabChange = (tab: CashTab) => {
    if (tab === activeTab || loading) return;
    setActiveTab(tab);
    setIdempotencyKey(uuidv4());
    setMessage(null);
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (loading) return;
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setIdempotencyKey(uuidv4());
    setMessage(null);
  };

  const formatMoney = (val: string) =>
    new Intl.NumberFormat("vi-VN").format(parseFloat(val || "0"));

  const getClientHintWarning = (): string | null => {
    if (!account) return null;
    if (account.status !== "ACTIVE") {
      return `Tài khoản của bạn hiện đang ở trạng thái ${account.status} (không phải ACTIVE). Giao dịch gửi lên sẽ bị máy chủ từ chối.`;
    }

    if (activeTab !== "withdraw") return null;

    const amountRegex = /^\d{1,16}(\.\d{1,2})?$/;
    const trimmed = formData.amount.trim();
    if (!trimmed || !amountRegex.test(trimmed)) return null;

    const amountNum = parseFloat(trimmed);
    if (amountNum <= 0) return null;

    if (account.limits) {
      const perTxNum = parseFloat(account.limits.perTransaction);
      const remDayNum = parseFloat(account.limits.remainingToday);

      if (amountNum > perTxNum) {
        return `Gợi ý hạn mức: Số tiền rút vượt hạn mức mỗi lần của hạng ${account.tier} (${formatMoney(account.limits.perTransaction)} ${account.currency}).`;
      }
      if (amountNum > remDayNum) {
        return `Gợi ý hạn mức: Số tiền rút vượt hạn mức còn lại trong ngày hôm nay (${formatMoney(account.limits.remainingToday)} ${account.currency}).`;
      }
    }

    const availNum = parseFloat(account.availableBalance);
    if (amountNum > availNum) {
      return `Gợi ý số dư: Số tiền rút vượt quá số dư khả dụng hiện tại (${formatMoney(account.availableBalance)} ${account.currency}).`;
    }

    return null;
  };

  const clientWarning = getClientHintWarning();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (inFlightRef.current) {
      return;
    }

    const amountRegex = /^\d{1,16}(\.\d{1,2})?$/;
    if (
      !amountRegex.test(formData.amount) ||
      parseFloat(formData.amount) <= 0
    ) {
      setMessage({
        type: "error",
        text: "Số tiền không hợp lệ (phải lớn hơn 0 và tối đa 2 chữ số thập phân).",
      });
      return;
    }

    inFlightRef.current = true;
    setLoading(true);
    setRetryStatus(null);
    setMessage(null);

    const endpoint =
      activeTab === "deposit"
        ? "/transactions/deposit"
        : "/transactions/withdraw";

    try {
      const result = await submitIdempotentTransaction<TransactionItem>(
        endpoint,
        {
          amount: formData.amount.trim(),
          description: formData.description.trim() || undefined,
        },
        idempotencyKey,
        (attempt, maxRetries) => {
          setRetryStatus(`Đang thử lại (lần ${attempt}/${maxRetries})...`);
        },
      );

      if (result.outcome === "indeterminate") {
        setMessage({
          type: "warning",
          text: "Chưa xác nhận được giao dịch. Vui lòng kiểm tra Lịch sử giao dịch trước khi thử lại, hoặc bấm xác nhận lại (hệ thống đang giữ nguyên mã chống trùng để kiểm tra an toàn).",
        });
        await fetchAccountAndRecentTransactions();
        return;
      }

      const isReplay = result.status === 200;
      const actionLabel = activeTab === "deposit" ? "Nạp tiền" : "Rút tiền";

      setMessage({
        type: "success",
        text: isReplay
          ? `Yêu cầu ${actionLabel.toLowerCase()} đã được xử lý trước đó (kết quả phát lại từ bản chụp Idempotency).`
          : `${actionLabel} thành công!`,
      });

      setFormData({ amount: "", description: "" });
      setIdempotencyKey(uuidv4());

      await fetchAccountAndRecentTransactions();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response) {
          const msg = err.response.data?.message;
          setMessage({
            type: "error",
            text: Array.isArray(msg)
              ? msg[0]
              : msg || "Có lỗi xảy ra khi thực hiện giao dịch.",
          });
          setIdempotencyKey(uuidv4());
          await fetchAccountAndRecentTransactions();
        } else {
          setMessage({
            type: "warning",
            text: "Chưa xác nhận được giao dịch do mất kết nối mạng. Bạn có thể bấm xác nhận lại (mã giao dịch được giữ nguyên để không bị xử lý trùng).",
          });
        }
      } else {
        setMessage({
          type: "error",
          text: "Có lỗi không xác định xảy ra.",
        });
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setRetryStatus(null);
    }
  };

  const renderStatusBadge = (status: TransactionItem["status"]) => {
    switch (status) {
      case "COMPLETED":
        return (
          <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">
            Thành công
          </span>
        );
      case "REVERSED":
        return (
          <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">
            Đã hoàn tiền
          </span>
        );
      case "PROCESSING":
      case "INITIATED":
      case "PENDING_OTP":
        return (
          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
            Đang xử lý
          </span>
        );
      case "FAILED":
        return (
          <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 font-medium">
            Thất bại
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-6 px-4 sm:px-0">
      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <div className="flex flex-wrap justify-between items-start gap-2 mb-6 border-b pb-3">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">
              Nạp / Rút tiền mặt
            </h2>
            {account && (
              <p className="text-xs text-gray-500 mt-1">
                STK: <strong>{account.accountNumber}</strong> | Hạng:{" "}
                <strong className="text-blue-700">{account.tier}</strong> |
                Trạng thái:{" "}
                <strong
                  className={
                    account.status === "ACTIVE"
                      ? "text-emerald-700"
                      : "text-red-600"
                  }
                >
                  {account.status}
                </strong>
              </p>
            )}
          </div>
          {account && (
            <div className="text-right">
              <span className="text-xs text-gray-500 block">
                Số dư khả dụng
              </span>
              <span className="text-lg font-bold text-green-700">
                {formatMoney(account.availableBalance)} {account.currency}
              </span>
              {parseFloat(account.holdAmount || "0") > 0 && (
                <span className="text-xs text-amber-700 block">
                  (Đang giữ chỗ: {formatMoney(account.holdAmount)}{" "}
                  {account.currency})
                </span>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-5 bg-gray-100 p-1 rounded-lg">
          <button
            type="button"
            disabled={loading}
            onClick={() => handleTabChange("deposit")}
            className={`py-2 text-sm font-semibold rounded-md transition ${
              activeTab === "deposit"
                ? "bg-emerald-600 text-white shadow"
                : "text-gray-700 hover:bg-gray-200"
            }`}
          >
            + Nạp tiền vào tài khoản
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => handleTabChange("withdraw")}
            className={`py-2 text-sm font-semibold rounded-md transition ${
              activeTab === "withdraw"
                ? "bg-amber-600 text-white shadow"
                : "text-gray-700 hover:bg-gray-200"
            }`}
          >
            - Rút tiền khỏi tài khoản
          </button>
        </div>

        {account?.limits && (
          <div className="mb-5 p-3 bg-slate-50 border border-slate-200 rounded-md text-xs text-gray-700 flex flex-wrap justify-between gap-2">
            {activeTab === "withdraw" ? (
              <>
                <span>
                  Hạn mức rút mỗi lần ({account.tier}):{" "}
                  <strong className="text-gray-900">
                    {formatMoney(account.limits.perTransaction)}{" "}
                    {account.currency}
                  </strong>
                </span>
                <span>
                  Hạn mức ngày còn lại hôm nay:{" "}
                  <strong className="text-emerald-700">
                    {formatMoney(account.limits.remainingToday)}{" "}
                    {account.currency}
                  </strong>{" "}
                  / {formatMoney(account.limits.perDay)} {account.currency}
                </span>
              </>
            ) : (
              <span>
                Giao dịch <strong>Nạp tiền</strong> không giới hạn hạn mức ngày,
                nhưng yêu cầu tài khoản ở trạng thái <strong>ACTIVE</strong>.
              </span>
            )}
          </div>
        )}

        {retryStatus && (
          <div className="p-4 mb-4 rounded-md bg-blue-50 text-blue-800 border border-blue-200 flex items-center justify-between">
            <span className="font-medium">{retryStatus}</span>
            <span className="text-xs text-blue-600">
              Đang dùng lại cùng Idempotency-Key
            </span>
          </div>
        )}

        {message && (
          <div
            className={`p-4 mb-4 rounded-md border ${
              message.type === "success"
                ? "bg-green-50 text-green-800 border-green-200"
                : message.type === "info"
                  ? "bg-blue-50 text-blue-800 border-blue-200"
                  : message.type === "warning"
                    ? "bg-amber-50 text-amber-900 border-amber-300"
                    : "bg-red-50 text-red-800 border-red-200"
            }`}
          >
            {message.text}
          </div>
        )}

        {clientWarning && (
          <div className="p-3 mb-4 rounded-md bg-amber-50 text-amber-900 border border-amber-300 text-sm">
            <p className="font-semibold">{clientWarning}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              {activeTab === "deposit"
                ? "Số tiền cần nạp (VND)"
                : "Số tiền cần rút (VND)"}
            </label>
            <input
              type="text"
              name="amount"
              required
              disabled={loading}
              value={formData.amount}
              onChange={handleChange}
              placeholder="VD: 100000"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 border text-gray-900 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Nội dung giao dịch (Tùy chọn)
            </label>
            <textarea
              name="description"
              rows={3}
              maxLength={200}
              disabled={loading}
              value={formData.description}
              onChange={handleChange}
              placeholder={
                activeTab === "deposit"
                  ? "VD: Nạp tiền mặt vào tài khoản..."
                  : "VD: Rút tiền mặt chi tiêu..."
              }
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 border text-gray-900 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition ${
              activeTab === "deposit"
                ? "bg-emerald-600 hover:bg-emerald-700"
                : "bg-amber-600 hover:bg-amber-700"
            }`}
          >
            {retryStatus
              ? retryStatus
              : loading
                ? "Đang xử lý giao dịch..."
                : activeTab === "deposit"
                  ? "Xác nhận nạp tiền"
                  : "Xác nhận rút tiền"}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <h3 className="text-lg font-bold text-gray-800 mb-4 border-b pb-2">
          Giao dịch gần đây
        </h3>
        {recentTransactions.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            Chưa có giao dịch nào.
          </p>
        ) : (
          <div className="divide-y divide-gray-200">
            {recentTransactions.map((tx) => {
              const isFailed = tx.status === "FAILED";
              return (
                <div
                  key={tx.id}
                  className="py-3 flex justify-between items-center text-sm"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-800">
                        {tx.type === "DEPOSIT"
                          ? "Nạp tiền (Tiền mặt)"
                          : tx.type === "WITHDRAW"
                            ? "Rút tiền (Tiền mặt)"
                            : tx.type === "REVERSAL"
                              ? `Hoàn tiền (${tx.counterpartyAccountNumber || "Hệ thống"})`
                              : tx.direction === "incoming"
                                ? `Nhận từ: ${tx.counterpartyAccountNumber || "Tiền mặt"}`
                                : `Chuyển tới: ${tx.counterpartyAccountNumber || "Tiền mặt"}`}
                      </p>
                      {renderStatusBadge(tx.status)}
                    </div>
                    <p className="text-xs text-gray-500">
                      {new Date(tx.createdAt).toLocaleString("vi-VN")}
                      {tx.description ? ` — ${tx.description}` : ""}
                    </p>
                  </div>
                  <span
                    className={`font-bold ${
                      isFailed
                        ? "text-gray-400 line-through"
                        : tx.direction === "incoming"
                          ? "text-green-600"
                          : "text-red-600"
                    }`}
                  >
                    {tx.direction === "incoming" ? "+" : "-"}
                    {formatMoney(tx.amount)} VND
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
