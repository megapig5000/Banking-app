'use client';

import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api } from '@/services/api';

export default function TransferPage() {
  const [formData, setFormData] = useState({ toAccountNumber: '', amount: '', description: '' });
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  // Tạo key mới khi load form
  useEffect(() => {
    setIdempotencyKey(uuidv4());
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    // Sinh key mới nếu user thay đổi nội dung form để tránh 409 Conflict với key cũ
    setIdempotencyKey(uuidv4());
    setMessage({ type: '', text: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const res = await api.post('/transactions/transfer', formData, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      setMessage({ type: 'success', text: `Chuyển khoản thành công! Mã GD: ${res.data.id}` });
      setFormData({ toAccountNumber: '', amount: '', description: '' });
      setIdempotencyKey(uuidv4()); // Tạo key mới cho lần chuyển tiếp theo
    } catch (err: any) {
      const msg = err.response?.data?.message;
      setMessage({ type: 'error', text: Array.isArray(msg) ? msg[0] : msg || 'Lỗi hệ thống' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 max-w-xl mx-auto mt-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6 border-b pb-2">Chuyển khoản nội bộ</h2>
      
      {message.text && (
        <div className={`mb-4 p-4 rounded-md ${message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Tài khoản đích</label>
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
          <label className="block text-sm font-medium text-gray-700">Số tiền (VND)</label>
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
          <label className="block text-sm font-medium text-gray-700">Nội dung chuyển khoản (Tùy chọn)</label>
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
          {loading ? 'Đang thực hiện...' : 'Xác nhận chuyển khoản'}
        </button>
      </form>
    </div>
  );
}