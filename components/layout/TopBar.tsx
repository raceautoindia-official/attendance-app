'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import Avatar from '@/components/ui/Avatar';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { getStoredUser, clearStoredUser } from '@/lib/user';
import type { StoredUser } from '@/lib/user';
import { cn } from '@/lib/cn';

interface TopBarProps {
  title: string;
}

export default function TopBar({ title }: TopBarProps) {
  const router = useRouter();
  const [user, setUser] = useState<StoredUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => { setUser(getStoredUser()); }, []);

  const logout = useMutation({
    mutationFn: async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
    },
    onSettled: () => {
      clearStoredUser();
      router.push('/login');
    },
  });

  return (
    <header className="h-14 flex-shrink-0 flex items-center justify-between px-4 md:px-6 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h1>

      <div className="flex items-center gap-2">
        <ThemeToggle />

        {user && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <Avatar name={user.name} size="sm" />
              <div className="hidden sm:block text-left">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200 leading-none">{user.name}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 capitalize leading-none mt-0.5">{user.role.replace('_', ' ')}</p>
              </div>
              <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className={cn(
                  'absolute right-0 top-full mt-1 w-40 z-20',
                  'bg-white dark:bg-slate-800 rounded-lg shadow-lg',
                  'border border-slate-200 dark:border-slate-700 py-1',
                )}>
                  <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700">
                    <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{user.emp_id}</p>
                  </div>
                  <button
                    onClick={() => logout.mutate()}
                    disabled={logout.isPending}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                  >
                    {logout.isPending ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
