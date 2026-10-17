'use client';

import { useQuery } from '@tanstack/react-query';
import { useCurrentUser } from '@/lib/useCurrentUser';
import type { NavAccess } from '@/lib/nav';
import type { ApiResponse } from '@/lib/types';

/**
 * What the signed-in person may do, for the navigation surfaces.
 *
 * Shared by the rail, the tab strip and the command palette through one query
 * key, so the three cannot show different menus to the same person.
 *
 * STARTS FROM THE STORED ROLE, deliberately. The server answer takes a moment,
 * and a rail that renders empty and then fills in reads as a broken page. The
 * provisional value is exactly the legacy rule the whole app used until roles
 * existed - `employees.role`, no explicit grants - so for every current user it
 * is already the right answer and the fetch only confirms it.
 */
export function useNavAccess(): NavAccess {
  const user = useCurrentUser();

  const provisional: NavAccess = {
    isSuperAdmin: user?.role === 'super_admin',
    explicit: false,
    legacyRole: user?.role ?? 'employee',
    grants: {},
  };

  const { data } = useQuery({
    queryKey: ['access', 'me'],
    queryFn: async () => {
      const res = await fetch('/api/access/me');
      const json = await res.json() as ApiResponse<NavAccess>;
      if (!json.success || !json.data) throw new Error(json.error ?? 'Could not read access');
      return json.data;
    },
    // Access changes when somebody is granted a role, which is rare and done
    // by a person who can reload. Re-asking on every mount is wasted.
    staleTime: 5 * 60_000,
    enabled: user !== null,
  });

  return data ?? provisional;
}
