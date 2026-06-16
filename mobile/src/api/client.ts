import { API_BASE_URL } from '../config';
import {
  getAccessToken,
  getRefreshToken,
  saveSession,
  clearSession,
} from '../storage/tokens';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Deduplicate concurrent refreshes (foreground + background task may overlap).
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/mobile/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) return false;
      await saveSession(json.data.accessToken, json.data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  // When false, a 401 is returned as-is without attempting a token refresh.
  autoRefresh?: boolean;
}

// Core fetch wrapper: attaches the bearer token, transparently refreshes once
// on 401, and parses the standard { success, data, error } envelope.
export async function apiFetch<T = unknown>(
  path: string,
  { method = 'GET', body, autoRefresh = true }: ApiOptions = {},
): Promise<T> {
  const send = async () => {
    const token = await getAccessToken();
    return fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Declares this client as mobile so the attendance routes (which are
        // mobile-only for employees) accept clock-in / clock-out.
        'sec-ch-ua-mobile': '?1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  };

  let res = await send();

  if (res.status === 401 && autoRefresh) {
    const ok = await tryRefresh();
    if (ok) {
      res = await send();
    }
  }

  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Refresh failed or token revoked — force re-login.
    await clearSession();
    throw new ApiError(401, 'Session expired. Please log in again.');
  }
  if (!res.ok || json?.success === false) {
    throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  }
  return json.data as T;
}

// --- Auth ------------------------------------------------------------------

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  employee: { id: number; emp_id: string; name: string; role: string; email: string | null };
}

export async function login(empId: string, pin: string): Promise<LoginResult> {
  const res = await fetch(`${API_BASE_URL}/api/auth/mobile/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emp_id: empId, pin }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new ApiError(res.status, json?.error ?? 'Login failed');
  }
  const data = json.data as LoginResult;
  await saveSession(data.accessToken, data.refreshToken, data.employee);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', autoRefresh: false });
  } catch {
    // ignore — we clear local session regardless
  }
  await clearSession();
}
