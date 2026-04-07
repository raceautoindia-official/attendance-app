'use client';

import { useState } from 'react';
import { getStoredUser, type StoredUser } from './user';

export function useCurrentUser(): StoredUser | null {
  const [user] = useState<StoredUser | null>(() =>
    typeof window !== 'undefined' ? getStoredUser() : null,
  );
  return user;
}
