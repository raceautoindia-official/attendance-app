'use client';

import { clearStoredUser } from './user';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let _refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  // Deduplicate concurrent refresh attempts — share the same promise
  if (_refreshing) return _refreshing;

  _refreshing = fetch('/api/auth/refresh', { method: 'POST' })
    .then(r => r.ok)
    .catch(() => false)
    .finally(() => { _refreshing = null; });

  return _refreshing;
}

function logout() {
  if (typeof window !== 'undefined') {
    clearStoredUser();
    window.location.href = '/login';
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (res.status === 401) {
    // Try to silently refresh the access token, then retry once
    const refreshed = await tryRefresh();
    if (refreshed) {
      const retry = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      if (retry.status === 401) {
        logout();
        throw new ApiError(401, 'Unauthorized');
      }
      const retryJson = await retry.json();
      if (!retry.ok) throw new ApiError(retry.status, retryJson?.error ?? `HTTP ${retry.status}`);
      return retryJson as T;
    }

    logout();
    throw new ApiError(401, 'Unauthorized');
  }

  const json = await res.json();
  if (!res.ok) {
    throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  }

  return json as T;
}
