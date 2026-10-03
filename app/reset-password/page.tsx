'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ApiResponse } from '@/lib/types';

// ---------------------------------------------------------------------------
// The page the emailed link opens. Deliberately a WEB page rather than a deep
// link into the app: an employee who has forgotten their PIN may be reading
// the mail on any device, and a deep link that fails to resolve leaves them
// with nowhere to go. This works in whatever browser opened the mail; they
// then sign in to the app with the new PIN.
// ---------------------------------------------------------------------------

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [checking, setChecking] = useState(true);
  const [who, setWho] = useState<{ name: string; emp_id: string } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Check the link BEFORE showing the form — being told "expired" after
  // carefully typing a new PIN twice is a small cruelty.
  useEffect(() => {
    (async () => {
      if (!token) { setLinkError('This link is missing its token.'); setChecking(false); return; }
      try {
        const res = await fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`);
        const json = (await res.json()) as ApiResponse<{ name: string; emp_id: string }>;
        if (json.success && json.data) setWho(json.data);
        else setLinkError(json.error ?? 'This link is no longer valid.');
      } catch {
        setLinkError('Could not reach the server. Check your connection and try again.');
      } finally {
        setChecking(false);
      }
    })();
  }, [token]);

  const submit = async () => {
    setError(null);
    if (!/^\d{4,6}$/.test(pin)) { setError('PIN must be 4 to 6 digits.'); return; }
    if (pin !== confirm) { setError('The two PINs do not match.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, pin }),
      });
      const json = (await res.json()) as ApiResponse;
      if (json.success) setDone(true);
      else setError(json.error ?? 'Could not change the PIN.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const card = 'w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800';
  const input = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-lg tracking-widest text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';

  if (checking) {
    return <div className={card}><p className="text-sm text-slate-500 dark:text-slate-400">Checking your link…</p></div>;
  }

  if (linkError) {
    return (
      <div className={card}>
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Link not valid</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{linkError}</p>
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Open the app and tap <strong>Forgot PIN?</strong> to send yourself a fresh link.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className={card}>
        <h1 className="text-lg font-semibold text-green-700 dark:text-green-400">PIN changed ✓</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Open the Attendance app and sign in with your new PIN. You have been signed
          out everywhere else, so no old session keeps working.
        </p>
      </div>
    );
  }

  return (
    <div className={card}>
      <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Set a new PIN</h1>
      {who && (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          for <strong>{who.name}</strong> ({who.emp_id})
        </p>
      )}

      <label className="mt-5 block text-sm font-medium text-slate-700 dark:text-slate-300">
        New PIN (4–6 digits)
        <input
          className={input}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
        />
      </label>

      <label className="mt-4 block text-sm font-medium text-slate-700 dark:text-slate-300">
        Type it again
        <input
          className={input}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          value={confirm}
          onChange={e => setConfirm(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
        />
      </label>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        onClick={() => void submit()}
        disabled={busy}
        className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Changing…' : 'Change my PIN'}
      </button>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-900">
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </main>
  );
}
