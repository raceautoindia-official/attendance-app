'use client';

import { useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import ThemeToggle from '@/components/ui/ThemeToggle';
import Avatar from '@/components/ui/Avatar';
import { clearStoredUser } from '@/lib/user';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { useEffect } from 'react';

export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useCurrentUser();
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const logout = useMutation({
    mutationFn: async () => { await fetch('/api/auth/logout', { method: 'POST' }); },
    onSettled: () => { clearStoredUser(); router.push('/login'); },
  });

  useEffect(() => {
    if (!user || user.role !== 'employee') return;
    let cancelled = false;
    const checkPasskey = async () => {
      try {
        const res = await fetch('/api/auth/webauthn/status', { cache: 'no-store' });
        const json = await res.json() as { success?: boolean; data?: { hasPasskey?: boolean } };
        if (cancelled) return;
        if (json.success && json.data?.hasPasskey === false) {
          router.replace('/register-passkey');
        }
      } catch {
        // ignore transient errors
      }
    };
    void checkPasskey();
    return () => { cancelled = true; };
  }, [user, router]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col">
      <header className="h-14 flex-shrink-0 flex items-center justify-between px-4 md:px-6 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/worklens-mark.png"
            alt=""
            className="w-7 h-7 rounded-lg object-contain"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">WorkLens</span>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {isClient && user && <Avatar name={user.name} size="sm" />}
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
