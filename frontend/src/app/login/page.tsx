"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";

export default function LoginPage() {
  const router = useRouter();
  const { login, authenticated, hydrated } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (hydrated && authenticated) router.push("/dashboard");
  }, [hydrated, authenticated, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await api.post("/auth/login", { email, password });
      login(res.data.user, res.data.accessToken);
      router.push("/dashboard");
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.message;
        setError(Array.isArray(msg) ? msg[0] : msg || "Đăng nhập thất bại");
      } else {
        setError("Đăng nhập thất bại");
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (!hydrated || authenticated) return null;

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8">
        <h2 className="text-2xl font-bold text-center text-gray-800 mb-6">
          Đăng Nhập
        </h2>
        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 rounded text-sm">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              type="email"
              required
              className="mt-1 block w-full border border-gray-300 rounded-md p-2 text-gray-900"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 text-white p-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? "Đang xử lý..." : "Đăng nhập"}
          </button>
        </form>
        <p className="mt-4 text-sm text-center text-gray-600">
          Chưa có tài khoản?{" "}
          <Link href="/register" className="text-blue-600 hover:underline">
            Đăng ký ngay
          </Link>
        </p>
      </div>
    </div>
  );
}
