import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  authenticated: boolean;
  hydrated: boolean;
  login: (user: User, accessToken: string) => void;
  logout: () => void;
  setHydrated: (state: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      authenticated: false,
      hydrated: false,
      login: (user, accessToken) => set({ user, accessToken, authenticated: true }),
      logout: () => set({ user: null, accessToken: null, authenticated: false }),
      setHydrated: (state) => set({ hydrated: state }),
    }),
    {
      name: 'auth-storage', // Lưu mặc định vào localStorage
      onRehydrateStorage: () => (state) => {
        if (state) state.setHydrated(true);
      },
    }
  )
);