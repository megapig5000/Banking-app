"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/services/api";

interface Account {
  id: string;
  accountNumber: string;
  balance: string;
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

  if (loading) return <div>Đang tải thông tin...</div>;
  if (!account) return <div>Không tìm thấy tài khoản ngân hàng.</div>;

  const formattedBalance = new Intl.NumberFormat("vi-VN").format(
    parseFloat(account.balance),
  );

  return (
    <div className="bg-white rounded-lg shadow-md p-6 max-w-2xl mx-auto mt-8 border border-gray-200">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-2">
        Thông tin tài khoản
      </h2>
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
        <div className="flex justify-between items-center bg-green-50 p-4 rounded-md border border-green-100">
          <span className="text-gray-600 font-medium">Số dư khả dụng:</span>
          <span className="text-2xl font-bold text-green-700">
            {formattedBalance} {account.currency}
          </span>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link
          href="/cash"
          className="text-center bg-emerald-600 text-white py-2.5 px-4 rounded-md font-medium hover:bg-emerald-700 transition"
        >
          Nạp / Rút tiền
        </Link>
        <Link
          href="/transfer"
          className="text-center bg-blue-600 text-white py-2.5 px-4 rounded-md font-medium hover:bg-blue-700 transition"
        >
          Chuyển khoản
        </Link>
        <Link
          href="/transactions"
          className="text-center bg-gray-100 text-gray-800 py-2.5 px-4 rounded-md font-medium hover:bg-gray-200 transition border border-gray-300"
        >
          Lịch sử giao dịch
        </Link>
      </div>
    </div>
  );
}
