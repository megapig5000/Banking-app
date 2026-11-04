"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { api, submitIdempotentTransaction } from "@/services/api";

type TransactionType = "TRANSFER" | "DEPOSIT" | "WITHDRAW" | "REVERSAL";
type TransactionStatus =
  | "INITIATED"
  | "PENDING_OTP"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "REVERSED";

interface Account {
  id: string;
  accountNumber: string;
  balance: string;
  currency: string;
  ownerName: string;
}

interface TransactionItem {
  id: string;
  amount: string;
  type: TransactionType;
  status: TransactionStatus;
  description: string | null;
  createdAt: string;
  direction: "incoming" | "outgoing";
  counterpartyAccountNumber: string | null;
  originalTransactionId?: string | null;
  reversalTransactionId?: string | null;
}

const STATUS_LABELS: Record<
  TransactionStatus,
  { label: string; className: string }
> = {
  COMPLETED: {
    label: "Thành công",
    className: "bg-green-100 text-green-800",
  },
  REVERSED: {
    label: "Đã được hoàn tiền",
    className: "bg-purple-100 text-purple-800",
  },
  PROCESSING: {
    label: "Đang xử lý",
    className: "bg-blue-100 text-blue-800",
  },
  INITIATED: {
    label: "Khởi tạo",
    className: "bg-gray-100 text-gray-800",
  },
  PENDING_OTP: {
    label: "Chờ OTP",
    className: "bg-yellow-100 text-yellow-800",
  },
  FAILED: {
    label: "Thất bại",
    className: "bg-red-100 text-red-800",
  },
};

export default function TransferPage() {
  const [formData, setFormData] = useState({
    toAccountNumber: "",
    amount: "",
    description: "",
  });
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuidv4());
  const [loading, setLoading] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "warning" | "";
    text: string;
  }>({ type: "", text: "" });

  // Cờ khóa đồng bộ bằng useRef để chặn bấm đúp trong cùng một tích tắc trước khi React kịp re-render
  const inFlightRef = useRef(false);

  const [account, setAccount] = useState<Account | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<
    TransactionItem[]
  >([]);

  const fetchAccountAndRecentTransactions = useCallback(async () => {
    try {
      const [accRes, txRes] = await Promise.all([
        api.get("/accounts/me"),
        api.get("/transactions?page=1&limit=5&order=desc"),
      ]);
      setAccount(accRes.data);
      setRecentTransactions(txRes.data.data);
    } catch (error) {
      console.error("Lỗi tải dữ liệu tài khoản và lịch sử", error);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get("/accounts/me"),
      api.get("/transactions?page=1&limit=5&order=desc"),
    ])
      .then(([accRes, txRes]) => {
        if (!active) return;
        setAccount(accRes.data);
        setRecentTransactions(txRes.data.data);
      })
      .catch((error) => {
        console.error("Lỗi tải dữ liệu tài khoản và lịch sử", error);
      });

    return () => {
      active = false;
    };
  }, []);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (inFlightRef.current) return;
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setIdempotencyKey(uuidv4());
    setMessage({ type: "", text: "" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Chặn ngay lần bấm thứ hai trong cùng tích tắc bằng cờ đồng bộ useRef
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    setRetryStatus(null);
    setMessage({ type: "", text: "" });

    try {
      const result = await submitIdempotentTransaction<TransactionItem>(
        "/transactions/transfer",
        formData,
        idempotencyKey,
        (attempt, maxRetries) => {
          setRetryStatus(`Đang thử lại (lần ${attempt}/${maxRetries})...`);
        },
      );

      // Nếu hết số lần thử lại mà vẫn chưa biết kết quả (timeout/mất mạng/202 kéo dài):
      // Trả về trạng thái "chưa xác định" và GIỮ NGUYÊN idempotencyKey để bấm gửi lại an toàn!
      if (result.outcome === "indeterminate") {
        const txHint = result.lastTransactionId
          ? ` (Mã GD tạm thời: ${result.lastTransactionId})`
          : "";
        setMessage({
          type: "warning",
          text: `Chưa xác nhận được giao dịch${txHint}. Vui lòng kiểm tra Lịch sử giao dịch trước khi thử lại, hoặc bấm Xác nhận chuyển khoản để kiểm tra lại với cùng mã giao dịch.`,
        });
        void fetchAccountAndRecentTransactions();
        return;
      }

      setMessage({
        type: "success",
        text: `Chuyển khoản thành công! Mã GD: ${result.data.id}`,
      });
      setFormData({ toAccountNumber: "", amount: "", description: "" });
      // Phản hồi kết thúc thành công (201/200) -> sinh Idempotency-Key mới
      setIdempotencyKey(uuidv4());

      await fetchAccountAndRecentTransactions();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // Khi có err.response (server đã trả về lỗi cuối cùng 4xx/5xx): sinh Idempotency-Key mới
        if (err.response) {
          setIdempotencyKey(uuidv4());
          void fetchAccountAndRecentTransactions();
        }
        const msg = err.response?.data?.message;
        setMessage({
          type: "error",
          text: Array.isArray(msg)
            ? msg[0]
            : msg || "Không thể thực hiện giao dịch, vui lòng thử lại",
        });
      } else {
        setMessage({ type: "error", text: "Lỗi hệ thống" });
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setRetryStatus(null);
    }
  };

  const formatMoney = (amount: string) =>
    new Intl.NumberFormat("vi-VN").format(parseFloat(amount));
  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleString("vi-VN");

  const getTypeLabel = (type: TransactionType) => {
    switch (type) {
      case "DEPOSIT":
        return "Nạp tiền";
      case "WITHDRAW":
        return "Rút tiền";
      case "REVERSAL":
        return "Hoàn tiền";
      default:
        return "Chuyển khoản";
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-6">
      {account && (
        <div className="bg-white rounded-lg shadow-md p-5 border border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-sm text-gray-500">
              Tài khoản nguồn:{" "}
              <span className="font-mono font-semibold text-gray-800">
                {account.accountNumber}
              </span>
            </p>
            <p className="text-sm text-gray-500">
              Chủ tài khoản:{" "}
              <span className="font-medium text-gray-800">
                {account.ownerName}
              </span>
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs text-gray-500 uppercase">Số dư khả dụng</p>
            <p className="text-2xl font-bold text-green-700">
              {formatMoney(account.balance)} {account.currency}
            </p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-2">
          Chuyển khoản nội bộ
        </h2>

        {retryStatus && (
          <div className="mb-4 p-4 rounded-md bg-blue-50 border border-blue-200 text-blue-800 text-sm font-medium">
            {retryStatus} Hệ thống đang giữ nguyên mã giao dịch để đảm bảo không
            trừ tiền hai lần.
          </div>
        )}

        {message.text && (
          <div
            className={`mb-4 p-4 rounded-md ${
              message.type === "success"
                ? "bg-green-100 text-green-800"
                : message.type === "warning"
                  ? "bg-amber-100 text-amber-900 border border-amber-300"
                  : "bg-red-100 text-red-800"
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Tài khoản đích
            </label>
            <input
              type="text"
              name="toAccountNumber"
              required
              disabled={loading}
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 disabled:bg-gray-100"
              value={formData.toAccountNumber}
              onChange={handleChange}
              placeholder="VD: 1000000002"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Số tiền (VND)
            </label>
            <input
              type="number"
              name="amount"
              required
              min="1"
              step="0.01"
              disabled={loading}
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 disabled:bg-gray-100"
              value={formData.amount}
              onChange={handleChange}
              placeholder="VD: 50000"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Nội dung chuyển khoản (Tùy chọn)
            </label>
            <textarea
              name="description"
              maxLength={200}
              rows={3}
              disabled={loading}
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 disabled:bg-gray-100"
              value={formData.description}
              onChange={handleChange}
            ></textarea>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white p-3 rounded-md font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading
              ? retryStatus || "Đang thực hiện..."
              : "Xác nhận chuyển khoản"}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <h3 className="text-lg font-bold text-gray-800 mb-4">
          Giao dịch gần đây
        </h3>
        {recentTransactions.length === 0 ? (
          <p className="text-sm text-gray-500">Chưa có giao dịch nào.</p>
        ) : (
          <div className="divide-y divide-gray-200">
            {recentTransactions.map((tx) => {
              const statusBadge = STATUS_LABELS[tx.status] ?? {
                label: tx.status,
                className: "bg-gray-100 text-gray-800",
              };
              const isFailed = tx.status === "FAILED";

              return (
                <div
                  key={tx.id}
                  className="py-3 flex items-center justify-between text-sm"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">
                        {getTypeLabel(tx.type)}
                      </span>
                      <span className="text-gray-500">
                        ({tx.counterpartyAccountNumber ?? "Tiền mặt"})
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge.className}`}
                      >
                        {statusBadge.label}
                      </span>
                    </div>
                    {tx.description && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {tx.description}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p
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
                    </p>
                    <p className="text-xs text-gray-400">
                      {formatDate(tx.createdAt)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
