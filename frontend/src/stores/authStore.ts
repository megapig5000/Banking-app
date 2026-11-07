import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UserRole = "CUSTOMER" | "ADMIN";
export type UserStatus = "active" | "locked";

export interface User {
  id: string;
  fullName: string;
  email: string;
  phone?: string | null;
  profileVersion?: number;
  role: UserRole;
  status: UserStatus | string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  authenticated: boolean;
  hydrated: boolean;
  login: (user: User, accessToken: string) => void;
  setAuth: (user: User, accessToken: string) => void;
  updateUser: (partialUser: Partial<User>) => void;
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

      login: (user, accessToken) =>
        set({ user, accessToken, authenticated: true }),

      setAuth: (user, accessToken) =>
        set({ user, accessToken, authenticated: true }),

      updateUser: (partialUser) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...partialUser } : null,
        })),

      logout: () =>
        set({ user: null, accessToken: null, authenticated: false }),

      setHydrated: (state) => set({ hydrated: state }),
    }),
    {
      name: "auth-storage",
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated(true);
        }
      },
    },
  ),
);
