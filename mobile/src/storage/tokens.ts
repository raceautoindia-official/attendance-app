import * as SecureStore from 'expo-secure-store';

// Tokens are kept in the OS secure storage (Android Keystore). They are read by
// both the foreground app and the background location task.
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
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
  if (employee) {
    await SecureStore.setItemAsync(EMPLOYEE_KEY, JSON.stringify(employee));
  }
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export async function getStoredEmployee(): Promise<StoredEmployee | null> {
  const raw = await SecureStore.getItemAsync(EMPLOYEE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredEmployee;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync(EMPLOYEE_KEY);
}
