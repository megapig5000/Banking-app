import axios from "axios";
import { useAuthStore } from "../stores/authStore";

// Các hằng số cấu hình Retry an toàn cho giao dịch (Bài 2.2)
export const TRANSACTION_REQUEST_TIMEOUT_MS = 10000;
export const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

export type IdempotentSubmitOutcome<T> =
  | {
      outcome: "completed";
      status: number;
      data: T;
    }
  | {
      outcome: "indeterminate";
      lastTransactionId?: string;
    };

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api",
  headers: {
    "Content-Type": "application/json",
  },
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url;
    // Bắt lỗi 401 nhưng bỏ qua login/register để form tự hiển thị lỗi.
    // Khi gọi logout(), ProtectedLayout sẽ tự động phát hiện authenticated=false và đẩy về /login.
    if (
      error.response?.status === 401 &&
      url !== "/auth/login" &&
      url !== "/auth/register"
    ) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkOrTimeoutError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  // Không nhận được phản hồi từ server (mất mạng, DNS, server pause, hoặc timeout ECONNABORTED)
  return !error.response || error.code === "ECONNABORTED";
}

/**
 * Hàm gửi yêu cầu giao dịch kèm cơ chế tự động thử lại an toàn (Idempotent Auto-Retry - Bài 2.2):
 * - Luôn giữ nguyên Idempotency-Key và payload trong suốt các lần thử lại.
 * - Chỉ thử lại (tối đa MAX_RETRIES = 3 lần, chờ 1s -> 2s -> 4s) khi:
 *   (1) Không nhận được phản hồi từ server (lỗi mạng hoặc timeout 10s), HOẶC
 *   (2) Server trả về 202 Accepted (giao dịch đang ở trạng thái IN_PROGRESS / PROCESSING).
 * - Dừng ngay lập tức khi nhận được phản hồi cuối cùng từ server (201/200 hoặc lỗi 4xx/5xx).
 * - Nếu hết 3 lần thử lại mà vẫn chưa ngã ngũ -> trả về { outcome: "indeterminate" }.
 */
export async function submitIdempotentTransaction<T = unknown>(
  endpoint: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  onRetry?: (retryAttempt: number, maxRetries: number) => void,
): Promise<IdempotentSubmitOutcome<T>> {
  let lastTransactionId: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      onRetry?.(attempt, MAX_RETRIES);
      const delayMs =
        RETRY_DELAYS_MS[attempt - 1] ??
        RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      await sleep(delayMs);
    }

    try {
      const response = await api.post<T>(endpoint, payload, {
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
        timeout: TRANSACTION_REQUEST_TIMEOUT_MS,
      });

      // Nếu nhận 202 Accepted (giao dịch đang được xử lý): tiếp tục chờ và retry bằng cùng key
      if (response.status === 202) {
        const bodyAny = response.data as Record<string, unknown> | undefined;
        if (bodyAny?.id && typeof bodyAny.id === "string") {
          lastTransactionId = bodyAny.id;
        }
        continue;
      }

      // Phản hồi thành công cuối cùng (201 Created hoặc 200 OK Replay)
      return {
        outcome: "completed",
        status: response.status,
        data: response.data,
      };
    } catch (error: unknown) {
      // Nếu là lỗi mạng hoặc timeout -> tiếp tục vòng lặp để thử lại (nếu còn lượt)
      if (isNetworkOrTimeoutError(error)) {
        continue;
      }

      // Nếu server đã trả về phản hồi lỗi cuối cùng (4xx/5xx) -> dừng ngay, không retry!
      throw error;
    }
  }

  // Đã hết MAX_RETRIES lần thử lại nhưng vẫn chỉ gặp lỗi mạng/timeout hoặc 202 Accepted
  return {
    outcome: "indeterminate",
    lastTransactionId,
  };
}
