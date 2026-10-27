"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { api } from "@/services/api";

export default function RegisterPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      await api.post("/auth/register", formData);
      alert("Đăng ký thành công! Vui lòng đăng nhập.");
      router.push("/login");
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.message;
        setError(Array.isArray(msg) ? msg[0] : msg || "Đăng ký thất bại");
      } else {
        setError("Đăng ký thất bại");
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-6">
          Đăng Ký Tài Khoản
        </h2>
        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Họ và tên
            </label>
            <input
              type="text"
              required
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 text-gray-900"
              onChange={(e) =>
                setFormData({ ...formData, fullName: e.target.value })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              required
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 text-gray-900"
              onChange={(e) =>
                setFormData({ ...formData, email: e.target.value })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Mật khẩu
            </label>
            <input
              type="password"
              required
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 text-gray-900"
              onChange={(e) =>
                setFormData({ ...formData, password: e.target.value })
              }
            />
            <p className="text-xs text-gray-500 mt-1">
              Tối thiểu 8 ký tự, gồm chữ và số.
            </p>
          </div>
          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-green-600 text-white p-2 rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            {isLoading ? "Đang xử lý..." : "Đăng ký"}
          </button>
        </form>
        <p className="mt-4 text-sm text-center text-gray-600">
          Đã có tài khoản?{" "}
          <Link href="/login" className="text-blue-600 hover:underline">
            Đăng nhập
          </Link>
        </p>
      </div>
    </div>
  );
}
