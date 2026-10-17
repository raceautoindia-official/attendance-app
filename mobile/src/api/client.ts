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
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  } catch {
    // Secure storage could not be READ — which is not "nothing stored". It
    // happens to background tasks on some locked phones (see storage/state.ts).
    // This used to mint a fresh id here: the server refused it as "not the
    // registered phone", so a background auto clock-in failed, and if the
    // write below then succeeded the install's real id was replaced for good.
    // Failing the request instead is safe — callers treat a plain Error as a
    // network blip and try again later.
    throw new Error('Could not read this phone\'s device id. Please try again.');
  }
  const id = stored ?? newDeviceId();
  if (!stored) await SecureStore.setItemAsync(DEVICE_ID_KEY, id).catch(() => {});
  cachedDeviceId = id;
  return id;
}

// ---------------------------------------------------------------------------
// Every fetch below used to have no timeout at all. On a bad mobile
// connection — the exact condition this app has to work through — a request
// that gets no response and no error just hangs, forever: login's button
// spins until the app is force-closed, because `await login(...)` never
// settles and `finally { setLoading(false) }` never runs. Reported in
// production as "sign-in is stuck loading for hours".
//
// 20s: long enough for a slow-but-working connection to finish a normal
// request, short enough that "stuck" becomes "try again" instead of "open
// forever". A THROWN, non-ApiError Error on timeout — not an ApiError —
// deliberately matches what a raw connection failure already throws, so
// every existing caller's handling keeps working unchanged: tracking.ts's
// shouldRetry() already treats "not an ApiError" as transient and retries it,
// and LoginScreen already shows e.message on anything it catches.
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Deduplicate concurrent refreshes (foreground + background task may overlap).
//
// THREE outcomes, not two. This returned a plain false for every failure, and
// apiFetch answered false by wiping the session — so a refresh that merely
// could not get through (no signal, a timeout, a 502 while the server
// restarted) logged the employee out. The access token lasts 15 minutes, so a
// phone on patchy mobile data hit this regularly; from then on every location
// fix was refused for want of a token, tracking looked alive and uploaded
// nothing, and the next time they opened the app it was at the login screen.
// Only the server REFUSING the refresh token says the session is over.
type RefreshOutcome = 'refreshed' | 'rejected' | 'unreachable';
let refreshing: Promise<RefreshOutcome> | null = null;

async function tryRefresh(): Promise<RefreshOutcome> {
  if (refreshing) return refreshing;
  refreshing = (async (): Promise<RefreshOutcome> => {
    let refreshToken: string | null;
    try {
      refreshToken = await getRefreshToken();
    } catch {
      return 'unreachable'; // secure storage unreadable right now — not a logout
    }
    if (!refreshToken) return 'rejected';
    let res: Response;
    try {
      res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/mobile/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return 'unreachable';
    }
    if (res.status === 401 || res.status === 403) return 'rejected';
    const json = await res.json().catch(() => ({}));
    // A 5xx, or a proxy's error page while the server restarts, is no verdict
    // on the token.
    if (!res.ok || !json?.success) return 'unreachable';
    await saveSession(json.data.accessToken, json.data.refreshToken);
    return 'refreshed';
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
    return fetchWithTimeout(`${API_BASE_URL}${path}`, {
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
    const outcome = await tryRefresh();
    if (outcome === 'refreshed') {
      res = await send();
    } else if (outcome === 'unreachable') {
      // The login could not be renewed because the server could not be
      // reached — the session itself is fine. Fail like any other network
      // error, which every caller already retries, and keep the session.
      throw new Error('Could not reach the server. Check your connection and try again.');
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
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/mobile/login`, {
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

/**
 * Sign out: the phone first, the server in the background.
 *
 * The server call used to come first and be awaited — up to the 20-second
 * timeout on a weak signal, with the Sign out button doing nothing visible.
 * And it sent only the access token, which after 15 minutes has expired, so
 * the server could not tell whose session to end and the refresh token stayed
 * valid for a week. Now the session is wiped here at once, and the server is
 * told which session to end by the refresh token itself.
 */
export async function logout(): Promise<void> {
  const [token, refreshToken] = await Promise.all([
    getAccessToken().catch(() => null),
    getRefreshToken().catch(() => null),
  ]);
  await clearSession().catch(() => {});
  const deviceId = await getDeviceId().catch(() => null);
  void fetchWithTimeout(`${API_BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sec-ch-ua-mobile': '?1',
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => {
    // Unreachable: the session is already gone from this phone, and the
    // refresh token will expire on its own.
  });
}

/**
 * Ask the server to email a PIN-reset link. Returns the sentence to show the
 * employee — deliberately the same whether or not the ID exists, so this
 * cannot be used to discover employee IDs. Throws only when the SERVER says it
 * cannot send mail at all, which is worth telling them plainly.
 */
export async function requestPasswordReset(empId: string): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE_URL}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emp_id: empId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new ApiError(res.status, json?.error ?? 'Could not request a reset.');
  }
  return json.message ?? 'If that employee ID exists, a reset link is on its way.';
}
