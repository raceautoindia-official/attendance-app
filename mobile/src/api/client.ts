import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../config';
import {
  getAccessToken,
  getRefreshToken,
  saveSession,
  clearSession,
} from '../storage/tokens';

export class ApiError extends Error {
  /**
   * The server's machine-readable refusal code and any facts it sent with it,
   * e.g. code 'outside_fence' plus the site name, its radius and how far out
   * the employee is. Matching on the MESSAGE instead would break the first time
   * the wording changed — and that message carries a distance, so it changes.
   */
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public info?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Per-install device identifier.
//
// Generated once and kept in secure storage, so it survives app restarts but
// not a reinstall (after which an admin re-registers the device). The server
// binds an employee to the first device it sees — see lib/deviceBinding.ts.
// ---------------------------------------------------------------------------
const DEVICE_ID_KEY = 'device_id';
let cachedDeviceId: string | null = null;

/** An identifier, not a secret — it names the install, it does not authorise it. */
function newDeviceId(): string {
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${Date.now().toString(16)}-${rand()}-${rand()}-${rand()}`;
}

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY).catch(() => null);
  const id = stored ?? newDeviceId();
  if (!stored) await SecureStore.setItemAsync(DEVICE_ID_KEY, id).catch(() => {});
  cachedDeviceId = id;
  return id;
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
    const deviceId = await getDeviceId();
    return fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Declares this client as mobile so the attendance routes (which are
        // mobile-only for employees) accept clock-in / clock-out.
        'sec-ch-ua-mobile': '?1',
        // Identifies THIS install. The server binds an employee to the first
        // device it sees and refuses others, so a desktop copying the header
        // above still cannot mark attendance. See lib/deviceBinding.ts.
        'x-device-id': deviceId,
        'x-device-platform': Platform.OS,
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
    throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`, json?.code, json);
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
