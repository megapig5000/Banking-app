"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";

interface UserProfile {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  profileVersion: number;
  role: "CUSTOMER" | "ADMIN";
  status: string;
  createdAt: string;
}

interface ProfileHistoryItem {
  version: number;
  fullName: string;
  email: string;
  phone: string | null;
  changedByUserId: string | null;
  changedAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function ProfilePage() {
  const { updateUser } = useAuthStore();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    phone: "",
    currentPassword: "",
  });
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const [historyItems, setHistoryItems] = useState<ProfileHistoryItem[]>([]);
  const [historyMeta, setHistoryMeta] = useState<PaginationMeta>({
    page: 1,
    limit: 5,
    total: 0,
    totalPages: 0,
  });
  const [loadingHistory, setLoadingHistory] = useState(true);

  const fetchHistoryPage = async (page = 1) => {
    try {
      setLoadingHistory(true);
      const res = await api.get("/users/me/profile-history", {
        params: { page, limit: 5, order: "desc" },
      });
      setHistoryItems(res.data.data || []);
      setHistoryMeta(
        res.data.meta || { page: 1, limit: 5, total: 0, totalPages: 0 },
      );
    } catch (error) {
      console.error("Lỗi tải lịch sử phiên bản hồ sơ:", error);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    let active = true;
    const loadInitialProfileAndHistory = async () => {
      try {
        const [profileRes, historyRes] = await Promise.all([
          api.get<UserProfile>("/users/me"),
          api.get("/users/me/profile-history", {
            params: { page: 1, limit: 5, order: "desc" },
          }),
        ]);
        if (!active) return;

        const data = profileRes.data;
        setProfile(data);
        setFormData({
          fullName: data.fullName || "",
          email: data.email || "",
          phone: data.phone || "",
          currentPassword: "",
        });
        setHistoryItems(historyRes.data.data || []);
        setHistoryMeta(
          historyRes.data.meta || {
            page: 1,
            limit: 5,
            total: 0,
            totalPages: 0,
          },
        );
      } catch (error) {
        console.error("Lỗi tải hồ sơ cá nhân:", error);
      } finally {
        if (active) {
          setLoadingProfile(false);
          setLoadingHistory(false);
        }
      }
    };

    void loadInitialProfileAndHistory();
    return () => {
      active = false;
    };
  }, []);

  const isEmailChanged =
    profile !== null &&
    formData.email.trim().toLowerCase() !== profile.email.toLowerCase();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (saving) return;
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setMessage(null);
  };

  const handleClearPhone = () => {
    if (saving) return;
    setFormData({ ...formData, phone: "" });
    setMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || saving) return;

    const trimmedName = formData.fullName.trim();
    const trimmedEmail = formData.email.trim().toLowerCase();
    const trimmedPhone = formData.phone.trim();

    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setMessage({
        type: "error",
        text: "Họ và tên phải có độ dài từ 2 đến 100 ký tự.",
      });
      return;
    }

    const phoneRegex = /^(\+84|0)\d{9}$/;
    if (trimmedPhone.length > 0 && !phoneRegex.test(trimmedPhone)) {
      setMessage({
        type: "error",
        text: "Số điện thoại không hợp lệ. Vui lòng nhập định dạng Việt Nam (0xxxxxxxxx hoặc +84xxxxxxxxx) hoặc để trống.",
      });
      return;
    }

    if (isEmailChanged && formData.currentPassword.length === 0) {
      setMessage({
        type: "error",
        text: "Vui lòng nhập mật khẩu hiện tại để xác nhận thay đổi địa chỉ email.",
      });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const payload: Record<string, string | null> = {
        fullName: trimmedName,
        email: trimmedEmail,
        phone: trimmedPhone.length > 0 ? trimmedPhone : null,
      };

      if (isEmailChanged) {
        payload.currentPassword = formData.currentPassword;
      }

      const prevVersion = profile.profileVersion;
      const res = await api.patch<UserProfile>("/users/me", payload);
      const updated = res.data;

      setProfile(updated);
      setFormData({
        fullName: updated.fullName || "",
        email: updated.email || "",
        phone: updated.phone || "",
        currentPassword: "",
      });

      updateUser({
        fullName: updated.fullName,
        email: updated.email,
        phone: updated.phone,
        profileVersion: updated.profileVersion,
      });

      if (updated.profileVersion === prevVersion) {
        setMessage({
          type: "info",
          text: "Thông tin hồ sơ không có thay đổi nào mới (phiên bản giữ nguyên).",
        });
      } else {
        setMessage({
          type: "success",
          text: `Cập nhật hồ sơ thành công! Đã lưu bản cũ (v${prevVersion}) vào lịch sử và nâng hồ sơ lên phiên bản v${updated.profileVersion}.`,
        });
      }

      await fetchHistoryPage(1);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        const msg = err.response.data?.message;
        setMessage({
          type: "error",
          text: Array.isArray(msg)
            ? msg[0]
            : msg || "Không thể cập nhật hồ sơ cá nhân.",
        });
      } else {
        setMessage({
          type: "error",
          text: "Lỗi kết nối máy chủ khi cập nhật hồ sơ.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadingProfile) {
    return (
      <div className="p-6 text-center text-gray-600">
        Đang tải thông tin hồ sơ...
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="p-6 text-center text-red-600">
        Không thể tải thông tin hồ sơ người dùng.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto mt-6 space-y-6 px-4 sm:px-0">
      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-6 border-b pb-3">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Hồ sơ cá nhân</h2>
            <p className="text-xs text-gray-500 mt-1">
              Mỗi lần thông tin thay đổi, bản chụp cũ được lưu tự động vào bảng{" "}
              <code>account_history</code> trước khi ghi đè.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200">
              Phiên bản hiện tại: v{profile.profileVersion}
            </span>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-800 border border-gray-300">
              Vai trò: {profile.role}
            </span>
          </div>
        </div>

        {message && (
          <div
            className={`p-4 mb-5 rounded-md border text-sm ${
              message.type === "success"
                ? "bg-green-50 text-green-800 border-green-200"
                : message.type === "info"
                  ? "bg-blue-50 text-blue-800 border-blue-200"
                  : "bg-red-50 text-red-800 border-red-200"
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Họ và tên
              </label>
              <input
                type="text"
                name="fullName"
                required
                minLength={2}
                maxLength={100}
                disabled={saving}
                value={formData.fullName}
                onChange={handleChange}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 border text-gray-900 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>

            <div>
              <div className="flex justify-between items-center">
                <label className="block text-sm font-medium text-gray-700">
                  Số điện thoại (Việt Nam)
                </label>
                {formData.phone && (
                  <button
                    type="button"
                    onClick={handleClearPhone}
                    disabled={saving}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Xóa SĐT
                  </button>
                )}
              </div>
              <input
                type="text"
                name="phone"
                disabled={saving}
                value={formData.phone}
                onChange={handleChange}
                placeholder="VD: 0901234567 hoặc +84901234567"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 border text-gray-900 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Địa chỉ Email
            </label>
            <input
              type="email"
              name="email"
              required
              disabled={saving}
              value={formData.email}
              onChange={handleChange}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 border text-gray-900 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
            />
          </div>

          {isEmailChanged && (
            <div className="p-4 bg-amber-50 border border-amber-300 rounded-md space-y-2">
              <label className="block text-sm font-semibold text-amber-900">
                Xác nhận mật khẩu hiện tại (Bắt buộc khi thay đổi Email)
              </label>
              <input
                type="password"
                name="currentPassword"
                required
                disabled={saving}
                value={formData.currentPassword}
                onChange={handleChange}
                placeholder="Nhập mật khẩu hiện tại của bạn..."
                className="block w-full rounded-md border-amber-300 shadow-sm p-2.5 border text-gray-900 bg-white focus:ring-amber-500 focus:border-amber-500"
              />
              <p className="text-xs text-amber-800">
                Để bảo vệ tài khoản khỏi bị chiếm đoạt khi đổi định danh đăng
                nhập, hệ thống yêu cầu xác thực lại mật khẩu hiện tại.
              </p>
            </div>
          )}

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="py-2.5 px-6 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50 transition"
            >
              {saving ? "Đang lưu thay đổi..." : "Lưu thay đổi hồ sơ"}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4 border-b pb-3">
          <div>
            <h3 className="text-xl font-bold text-gray-800">
              Lịch sử phiên bản hồ sơ đã lưu
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Các bản chụp thông tin cũ trước mỗi lần cập nhật (Mới nhất hiển
              thị trước)
            </p>
          </div>
          <span className="text-xs font-medium text-gray-600">
            Tổng số bản lưu: <strong>{historyMeta.total}</strong>
          </span>
        </div>

        {loadingHistory ? (
          <div className="py-8 text-center text-gray-500 text-sm">
            Đang tải lịch sử phiên bản...
          </div>
        ) : historyItems.length === 0 ? (
          <div className="py-8 text-center text-gray-500 text-sm">
            Chưa có lịch sử thay đổi hồ sơ nào (Hồ sơ vẫn đang ở phiên bản gốc
            v1).
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">
                      Phiên bản cũ
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">
                      Họ và tên (Cũ)
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">
                      Email (Cũ)
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">
                      Số điện thoại (Cũ)
                    </th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">
                      Thời điểm lưu vết
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {historyItems.map((item) => (
                    <tr key={item.version} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-800 border border-slate-300">
                          v{item.version}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {item.fullName}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{item.email}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {item.phone ? (
                          <span className="font-mono">{item.phone}</span>
                        ) : (
                          <span className="text-gray-400 italic">
                            (Chưa cập nhật)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {new Date(item.changedAt).toLocaleString("vi-VN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {historyMeta.totalPages > 1 && (
              <div className="mt-4 pt-3 border-t flex items-center justify-between text-sm">
                <span className="text-gray-600">
                  Trang <strong>{historyMeta.page}</strong> /{" "}
                  <strong>{historyMeta.totalPages}</strong>
                </span>
                <div className="space-x-2">
                  <button
                    type="button"
                    disabled={historyMeta.page <= 1 || loadingHistory}
                    onClick={() => void fetchHistoryPage(historyMeta.page - 1)}
                    className="px-3 py-1.5 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Trang trước
                  </button>
                  <button
                    type="button"
                    disabled={
                      historyMeta.page >= historyMeta.totalPages ||
                      loadingHistory
                    }
                    onClick={() => void fetchHistoryPage(historyMeta.page + 1)}
                    className="px-3 py-1.5 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Trang sau
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
