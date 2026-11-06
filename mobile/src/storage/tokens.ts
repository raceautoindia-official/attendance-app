import * as SecureStore from 'expo-secure-store';
import { withTimeout } from '../util/withTimeout';

// Tokens are kept in the OS secure storage (Android Keystore). They are read by
// both the foreground app and the background location task.
//
// Every READ below swallows its errors and answers null. The Android Keystore
// has a documented failure mode — see storage/state.ts, written to route
// around it — where reads fail on some devices and on locked devices during
// background work. An exception out of getAccessToken() is not a recoverable
// error anywhere it is called: in apiFetch it fails the request with a message
// about keystores, and in App.tsx's bootstrap it left `authed` null for ever,
// which is a permanent spinner on the splash screen and indistinguishable from
// a hung app. "No token" is both truthful and actionable — it shows the login
// screen — so that is what a failed read reports.
//
// WRITES still throw on purpose: saveSession() failing means the session was
// not persisted, and silently continuing would log someone in until the app
// next restarts and then mysteriously log them out.
const ACCESS_KEY = 'access_token';
const REFRESH_KEY = 'refresh_token';
const EMPLOYEE_KEY = 'employee';

export interface StoredEmployee {
  id: number;
  emp_id: string;
  name: string;
  role: string;
  email: string | null;
}

export async function saveSession(
  accessToken: string,
  refreshToken: string,
  employee?: StoredEmployee,
): Promise<void> {
  // Bounded, and still allowed to throw. saveSession() runs inside login(),
  // whose caller shows the message and releases the button — so a timeout here
  // surfaces as a failed sign-in they can retry. Left unbounded it was a sign-in
  // that never finished and never failed, which is the shape of hang this
  // release set out to remove.
  const save = (key: string, value: string) => withTimeout(
    SecureStore.setItemAsync(key, value),
    10_000,
    'Could not save your session on this phone. Try signing in again.',
  );
  await save(ACCESS_KEY, accessToken);
  await save(REFRESH_KEY, refreshToken);
  if (employee) {
    await save(EMPLOYEE_KEY, JSON.stringify(employee));
  }
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_KEY).catch(() => null);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY).catch(() => null);
}

export async function getStoredEmployee(): Promise<StoredEmployee | null> {
  const raw = await SecureStore.getItemAsync(EMPLOYEE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredEmployee;
  } catch {
    return null;
  }
}

// Best-effort on each key independently: a failure on one must not leave the
// other two behind. A half-cleared session is worse than a failed clear —
// clearSession() is what a forced logout relies on.
export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(EMPLOYEE_KEY).catch(() => {}),
  ]);
}
