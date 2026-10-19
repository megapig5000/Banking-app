'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/services/api';

interface Transaction {
  id: string;
  amount: string;
  type: string;
  status: string;
  description: string;
  createdAt: string;
  direction: 'incoming' | 'outgoing';
  counterpartyAccountNumber: string | null;
}

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function TransactionsPage() {
  const [data, setData] = useState<Transaction[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);

  const [filters, setFilters] = useState({
    page: 1,
    limit: 10,
    direction: '',
    fromDate: '',
    toDate: '',
    order: 'desc',
  });

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', filters.page.toString());
      params.append('limit', filters.limit.toString());
      params.append('order', filters.order);
      if (filters.direction) params.append('direction', filters.direction);
      if (filters.fromDate) params.append('fromDate', filters.fromDate);
      if (filters.toDate) params.append('toDate', filters.toDate);

      const res = await api.get(`/transactions?${params.toString()}`);
      setData(res.data.data);
      setMeta(res.data.meta);
    } catch (error) {
      console.error('Lỗi tải lịch sử', error);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    setFilters({ ...filters, [e.target.name]: e.target.value, page: 1 });
  };

  const formatMoney = (amount: string) => new Intl.NumberFormat('vi-VN').format(parseFloat(amount));
  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleString('vi-VN');

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mt-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Lịch sử giao dịch</h2>

      {/* Filter Section */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6 p-4 bg-gray-50 rounded-md border">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Loại giao dịch</label>
          <select name="direction" value={filters.direction} onChange={handleFilterChange} className="w-full p-2 border rounded text-sm text-gray-900">
            <option value="">Tất cả</option>
            <option value="incoming">Tiền vào (Incoming)</option>
            <option value="outgoing">Tiền ra (Outgoing)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Từ ngày</label>
          <input type="date" name="fromDate" value={filters.fromDate} onChange={handleFilterChange} className="w-full p-2 border rounded text-sm text-gray-900" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Đến ngày</label>
          <input type="date" name="toDate" value={filters.toDate} onChange={handleFilterChange} className="w-full p-2 border rounded text-sm text-gray-900" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Sắp xếp</label>
          <select name="order" value={filters.order} onChange={handleFilterChange} className="w-full p-2 border rounded text-sm text-gray-900">
            <option value="desc">Mới nhất trước</option>
            <option value="asc">Cũ nhất trước</option>
          </select>
        </div>
      </div>

      {/* Table Section */}
      {loading ? (
        <div className="text-center py-10">Đang tải dữ liệu...</div>
      ) : data.length === 0 ? (
        <div className="text-center py-10 text-gray-500 bg-gray-50 rounded border border-dashed">Chưa có giao dịch nào.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 border">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Thời gian</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Loại</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Đối tác</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Số tiền (VND)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Nội dung</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((tx) => (
                <tr key={tx.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3 text-sm text-gray-600">{formatDate(tx.createdAt)}</td>
                  <td className="px-4 py-3 text-sm">
                    {tx.direction === 'incoming' ? (
                      <span className="text-green-600 font-medium bg-green-100 px-2 py-1 rounded text-xs">+ Nhận tiền</span>
                    ) : (
                      <span className="text-red-600 font-medium bg-red-100 px-2 py-1 rounded text-xs">- Chuyển tiền</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 font-mono">{tx.counterpartyAccountNumber}</td>
                  <td className={`px-4 py-3 text-sm font-bold text-right ${tx.direction === 'incoming' ? 'text-green-600' : 'text-red-600'}`}>
                    {tx.direction === 'incoming' ? '+' : '-'}{formatMoney(tx.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 truncate max-w-xs">{tx.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Section */}
      {meta && meta.totalPages > 1 && (
        <div className="flex justify-between items-center mt-6">
          <span className="text-sm text-gray-600">
            Trang {meta.page} / {meta.totalPages} (Tổng: {meta.total})
          </span>
          <div className="space-x-2">
            <button
              onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
              disabled={filters.page === 1}
              className="px-4 py-2 border rounded text-sm bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Trước
            </button>
            <button
              onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
              disabled={filters.page === meta.totalPages}
              className="px-4 py-2 border rounded text-sm bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Sau
            </button>
          </div>
        </div>
      )}
    </div>
  );
}