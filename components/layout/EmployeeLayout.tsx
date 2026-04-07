'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import ThemeToggle from '@/components/ui/ThemeToggle';
import Avatar from '@/components/ui/Avatar';
import { getStoredUser, clearStoredUser } from '@/lib/user';
import type { StoredUser } from '@/lib/user';

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<StoredUser | null>(null);

  useEffect(() => { setUser(getStoredUser()); }, []);

  const logout = useMutation({
    mutationFn: async () => { await fetch('/api/auth/logout', { method: 'POST' }); },
    onSettled: () => { clearStoredUser(); router.push('/login'); },
  });

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col">
      <header className="h-14 flex-shrink-0 flex items-center justify-between px-4 md:px-6 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">Attendance</span>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {user && <Avatar name={user.name} size="sm" />}
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-red-500 transition-colors px-2 py-1"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-8 max-w-2xl mx-auto w-full">
        {children}
      </main>
    </div>
  );
}
