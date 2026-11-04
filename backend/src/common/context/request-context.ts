import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import type { User } from '../../database/entities/user.entity';

export interface RequestContextStore {
  req: Request & { user?: User };
}

export interface RequestContextSnapshot {
  actorId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export const requestContextStorage =
  new AsyncLocalStorage<RequestContextStore>();

export const MAX_IP_ADDRESS_LENGTH = 64;
export const MAX_USER_AGENT_LENGTH = 255;

/**
 * Đọc trễ (lazy read) thông tin người thực hiện, IP và User-Agent từ ngữ cảnh request hiện tại.
 * Vì Guard chạy sau Middleware nên lúc Subscriber hoặc Interceptor gọi hàm này, req.user đã được nạp từ DB.
 */
export function getRequestContextSnapshot(): RequestContextSnapshot {
  const store = requestContextStorage.getStore();
  if (!store || !store.req) {
    return {
      actorId: null,
      ipAddress: null,
      userAgent: null,
    };
  }

  const { req } = store;
  const actorId = req.user?.id ?? null;

  const rawIp =
    typeof req.ip === 'string' && req.ip.trim().length > 0
      ? req.ip.trim()
      : (req.socket?.remoteAddress?.trim() ?? null);
  const ipAddress = rawIp ? rawIp.slice(0, MAX_IP_ADDRESS_LENGTH) : null;

  const rawUa = req.headers?.['user-agent'];
  const uaStr = Array.isArray(rawUa) ? rawUa[0] : rawUa;
  const userAgent =
    typeof uaStr === 'string' && uaStr.trim().length > 0
      ? uaStr.trim().slice(0, MAX_USER_AGENT_LENGTH)
      : null;

  return {
    actorId,
    ipAddress,
    userAgent,
  };
}
