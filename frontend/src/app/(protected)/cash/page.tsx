"use client";

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { api } from "@/services/api";

type CashTab = "deposit" | "withdraw";

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
  type: "transfer" | "deposit" | "withdraw";
  status: string;
  description: string | null;
  createdAt: string;
  direction: "incoming" | "outgoing";
  counterpartyAccountNumber: string | null;
}

const AMOUNT_REGEX = /^\d{1,16}(\.\d{1,2})?$/;

export default function CashPage() {
  const [activeTab, setActiveTab] = useState<CashTab>("deposit");
  const [formData, setFormData] = useState({ amount: "", description: "" });
  // Khởi tạo trực tiếp UUID ngay trong useState thay vì gọi setState trong useEffect
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuidv4());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

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

  const handleTabChange = (tab: CashTab) => {
    if (tab === activeTab || loading) return;
    setActiveTab(tab);
    setIdempotencyKey(uuidv4());
    setMessage({ type: "", text: "" });
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setIdempotencyKey(uuidv4());
    setMessage({ type: "", text: "" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage({ type: "", text: "" });

    const trimmedAmount = formData.amount.trim();
    if (!AMOUNT_REGEX.test(trimmedAmount) || parseFloat(trimmedAmount) <= 0) {
      setMessage({
        type: "error",
        text: "Số tiền không hợp lệ. Phải lớn hơn 0 và tối đa 2 chữ số thập phân.",
      });
      return;
    }

    setLoading(true);

    try {
      const endpoint =
        activeTab === "deposit"
          ? "/transactions/deposit"
          : "/transactions/withdraw";

      const payload: { amount: string; description?: string } = {
        amount: trimmedAmount,
      };
      if (formData.description.trim()) {
        payload.description = formData.description.trim();
      }

      const res = await api.post(endpoint, payload, {
        headers: { "Idempotency-Key": idempotencyKey },
      });

      const actionLabel = activeTab === "deposit" ? "Nạp tiền" : "Rút tiền";
      setMessage({
        type: "success",
        text: `${actionLabel} thành công! Mã GD: ${res.data.id}`,
      });
      setFormData({ amount: "", description: "" });
      setIdempotencyKey(uuidv4());

      await fetchAccountAndRecentTransactions();
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.message;
        setMessage({
          type: "error",
          text: Array.isArray(msg) ? msg[0] : msg || "Lỗi hệ thống",
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

  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-6">
      {account && (
        <div className="bg-white rounded-lg shadow-md p-5 border border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <p className="text-sm text-gray-500">
              Tài khoản:{" "}
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
        <div className="flex border-b mb-6">
          <button
            type="button"
            onClick={() => handleTabChange("deposit")}
            className={`flex-1 py-3 text-center font-semibold border-b-2 transition ${
              activeTab === "deposit"
                ? "border-emerald-600 text-emerald-700 bg-emerald-50/50"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            + Nạp tiền vào tài khoản
          </button>
          <button
            type="button"
            onClick={() => handleTabChange("withdraw")}
            className={`flex-1 py-3 text-center font-semibold border-b-2 transition ${
              activeTab === "withdraw"
                ? "border-amber-600 text-amber-700 bg-amber-50/50"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            - Rút tiền mặt
          </button>
        </div>

        {message.text && (
          <div
            className={`mb-4 p-4 rounded-md ${
              message.type === "success"
                ? "bg-green-100 text-green-800"
                : "bg-red-100 text-red-800"
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Số tiền {activeTab === "deposit" ? "nạp" : "rút"} (VND)
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
              placeholder="VD: 100000"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Nội dung giao dịch (Tùy chọn)
            </label>
            <textarea
              name="description"
              maxLength={200}
              rows={3}
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
              value={formData.description}
              onChange={handleChange}
              placeholder={
                activeTab === "deposit"
                  ? "VD: Nạp tiền mặt vào tài khoản"
                  : "VD: Rút tiền mặt chi tiêu"
              }
            ></textarea>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full text-white p-3 rounded-md font-semibold disabled:opacity-50 transition ${
              activeTab === "deposit"
                ? "bg-emerald-600 hover:bg-emerald-700"
                : "bg-amber-600 hover:bg-amber-700"
            }`}
          >
            {loading
              ? "Đang thực hiện..."
              : activeTab === "deposit"
                ? "Xác nhận nạp tiền"
                : "Xác nhận rút tiền"}
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
            {recentTransactions.map((tx) => (
              <div
                key={tx.id}
                className="py-3 flex items-center justify-between text-sm"
              >
                <div>
                  <span className="font-medium text-gray-900">
                    {tx.type === "deposit"
                      ? "Nạp tiền"
                      : tx.type === "withdraw"
                        ? "Rút tiền"
                        : "Chuyển khoản"}
                  </span>
                  <span className="text-gray-500 ml-2">
                    ({tx.counterpartyAccountNumber ?? "Tiền mặt"})
                  </span>
                  {tx.description && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {tx.description}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p
                    className={`font-bold ${
                      tx.direction === "incoming"
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
