'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/authStore';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { authenticated, hydrated, logout, user } = useAuthStore();

  useEffect(() => {
    if (hydrated && !authenticated) {
      router.push('/login');
    }
  }, [hydrated, authenticated, router]);

  if (!hydrated || !authenticated) {
    return <div className="flex h-screen items-center justify-center">Authenticating...</div>;
  }

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const navClass = (path: string) =>
    `px-3 py-2 rounded-md text-sm font-medium ${
      pathname === path ? 'bg-blue-700 text-white' : 'text-blue-100 hover:bg-blue-600 hover:text-white'
    }`;

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-blue-800 shadow-md">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-4">
              <span className="text-white font-bold text-xl mr-4">SimpleBank</span>
              <Link href="/dashboard" className={navClass('/dashboard')}>Dashboard</Link>
              <Link href="/transfer" className={navClass('/transfer')}>Chuyển khoản</Link>
              <Link href="/transactions" className={navClass('/transactions')}>Lịch sử</Link>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-blue-200">Xin chào, {user?.fullName}</span>
              <button
                onClick={handleLogout}
                className="px-3 py-2 rounded-md text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition"
              >
                Đăng xuất
              </button>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-6xl mx-auto py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}