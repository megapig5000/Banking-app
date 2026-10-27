"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/authStore";

export default function Home() {
  const router = useRouter();
  const { authenticated, hydrated } = useAuthStore();

  useEffect(() => {
    if (hydrated) {
      if (authenticated) router.push("/dashboard");
      else router.push("/login");
    }
  }, [authenticated, hydrated, router]);

  return (
    <div className="flex h-screen items-center justify-center">Loading...</div>
  );
}
