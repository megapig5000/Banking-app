'use client';

import { useEffect, useState } from 'react';
import { api } from '@/services/api';

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
        const res = await api.get('/accounts/me');
        setAccount(res.data);
      } catch (error) {
        console.error('Lỗi tải tài khoản', error);
      } finally {
        setLoading(false);
      }
    };
    fetchAccount();
  }, []);

  if (loading) return <div>Đang tải thông tin...</div>;
  if (!account) return <div>Không tìm thấy tài khoản ngân hàng.</div>;

  const formattedBalance = new Intl.NumberFormat('vi-VN').format(parseFloat(account.balance));

  return (
    <div className="bg-white rounded-lg shadow-md p-6 max-w-2xl mx-auto mt-8 border border-gray-200">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-2">Thông tin tài khoản</h2>
      <div className="space-y-4">
        <div className="flex justify-between items-center bg-gray-50 p-4 rounded-md">
          <span className="text-gray-600 font-medium">Chủ tài khoản:</span>
          <span className="text-lg font-semibold text-gray-900">{account.ownerName}</span>
        </div>
        <div className="flex justify-between items-center bg-gray-50 p-4 rounded-md">
          <span className="text-gray-600 font-medium">Số tài khoản:</span>
          <span className="text-lg font-bold text-blue-600 tracking-wider">{account.accountNumber}</span>
        </div>
        <div className="flex justify-between items-center bg-green-50 p-4 rounded-md border border-green-100">
          <span className="text-gray-600 font-medium">Số dư khả dụng:</span>
          <span className="text-2xl font-bold text-green-700">
            {formattedBalance} {account.currency}
          </span>
        </div>
      </div>
    </div>
  );
}