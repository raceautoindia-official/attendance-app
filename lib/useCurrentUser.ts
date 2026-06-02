'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { USER_KEY, getStoredUser, type StoredUser } from './user';

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key === USER_KEY) onStoreChange();
  };
  const onUserChanged = () => onStoreChange();

  window.addEventListener('storage', onStorage);
  window.addEventListener('attendance-user-changed', onUserChanged);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('attendance-user-changed', onUserChanged);
  };
}

export function useCurrentUser(): StoredUser | null {
  const rawUser = useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? null : localStorage.getItem(USER_KEY)),
    () => null,
  );

  return useMemo(() => {
    if (!rawUser) return null;
    return getStoredUser();
  }, [rawUser]);
}
