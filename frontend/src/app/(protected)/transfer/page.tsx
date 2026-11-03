"use client";

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { api } from "@/services/api";

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
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info" | "";
    text: string;
  }>({ type: "", text: "" });

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
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setIdempotencyKey(uuidv4());
    setMessage({ type: "", text: "" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ type: "", text: "" });

    try {
      const res = await api.post("/transactions/transfer", formData, {
        headers: { "Idempotency-Key": idempotencyKey },
      });

      // Nếu nhận 202 Accepted (đang xử lý PROCESSING): giữ nguyên Idempotency-Key
      if (res.status === 202) {
        setMessage({
          type: "info",
          text: `Giao dịch đang được xử lý, vui lòng kiểm tra lại sau. Mã GD: ${res.data.id}`,
        });
        await fetchAccountAndRecentTransactions();
        return;
      }

      setMessage({
        type: "success",
        text: `Chuyển khoản thành công! Mã GD: ${res.data.id}`,
      });
      setFormData({ toAccountNumber: "", amount: "", description: "" });
      // Phản hồi kết thúc thành công (201/200) -> sinh Idempotency-Key mới
      setIdempotencyKey(uuidv4());

      await fetchAccountAndRecentTransactions();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // Nếu server đã trả về phản hồi lỗi cuối cùng (4xx/5xx) -> sinh Idempotency-Key mới
        // Nếu lỗi mạng (!err.response) -> giữ nguyên key để retry an toàn
        if (err.response) {
          setIdempotencyKey(uuidv4());
          void fetchAccountAndRecentTransactions();
        }
        const msg = err.response?.data?.message;
        setMessage({
          type: "error",
          text: Array.isArray(msg)
            ? msg[0]
            : msg || "Không thể kết nối tới máy chủ, vui lòng thử lại",
        });
      } else {
        setMessage({ type: "error", text: "Lỗi hệ thống" });
      }
    } finally {
      setLoading(false);
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

        {message.text && (
          <div
            className={`mb-4 p-4 rounded-md ${
              message.type === "success"
                ? "bg-green-100 text-green-800"
                : message.type === "info"
                  ? "bg-blue-100 text-blue-800"
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
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
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
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
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
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
              value={formData.description}
              onChange={handleChange}
            ></textarea>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white p-3 rounded-md font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading ? "Đang thực hiện..." : "Xác nhận chuyển khoản"}
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
