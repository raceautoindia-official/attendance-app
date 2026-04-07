'use client';

import { useEffect, useState } from 'react';
import { getStoredUser, type StoredUser } from './user';

export function useCurrentUser(): StoredUser | null {
  const [user, setUser] = useState<StoredUser | null>(null);

  useEffect(() => {
    setUser(getStoredUser());
  }, []);

  return user;
}
