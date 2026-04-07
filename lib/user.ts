export interface StoredUser {
  id: number;
  emp_id: string;
  name: string;
  role: string;
}

const USER_KEY = 'attendance_user';

export function storeUser(user: StoredUser): void {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* ignore */ }
}

export function getStoredUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  } catch { return null; }
}

export function clearStoredUser(): void {
  try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ }
}
