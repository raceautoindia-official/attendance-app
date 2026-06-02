export interface StoredUser {
  id: number;
  emp_id: string;
  name: string;
  role: string;
}

export const USER_KEY = 'attendance_user';
const BIOMETRIC_EMP_KEY = 'biometric_emp_id';
const USER_CHANGED_EVENT = 'attendance-user-changed';

function notifyUserChanged(): void {
  try { window.dispatchEvent(new Event(USER_CHANGED_EVENT)); } catch { /* ignore */ }
}

export function storeUser(user: StoredUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    notifyUserChanged();
  } catch { /* ignore */ }
}

export function getStoredUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  } catch { return null; }
}

export function clearStoredUser(): void {
  try {
    localStorage.removeItem(USER_KEY);
    notifyUserChanged();
  } catch { /* ignore */ }
}

export function storeBiometricEmpId(empId: string): void {
  try { localStorage.setItem(BIOMETRIC_EMP_KEY, empId); } catch { /* ignore */ }
}

export function getBiometricEmpId(): string | null {
  try { return localStorage.getItem(BIOMETRIC_EMP_KEY); } catch { return null; }
}

export function clearBiometricEmpId(): void {
  try { localStorage.removeItem(BIOMETRIC_EMP_KEY); } catch { /* ignore */ }
}
