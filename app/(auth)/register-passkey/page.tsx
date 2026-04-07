'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { getStoredUser } from '@/lib/user';
import type { ApiResponse } from '@/lib/types';

export default function RegisterPasskeyPage() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'registering' | 'success' | 'error'>('idle');
  const storedUser = typeof window !== 'undefined' ? getStoredUser() : null;
  const skipDest = storedUser?.role === 'employee' ? '/dashboard' : '/overview';
  const [message, setMessage] = useState<string | null>(null);

  const notSupported =
    typeof window !== 'undefined' &&
    !window.PublicKeyCredential;

  async function handleRegister() {
    setState('registering');
    setMessage(null);
    try {
      const optRes = await fetch('/api/auth/webauthn/register');
      const optJson = await optRes.json() as ApiResponse<object>;
      if (!optJson.success || !optJson.data) {
        if (optRes.status === 401) {
          setMessage('You must be signed in to register a passkey. Please sign in first.');
          setState('error');
          return;
        }
        throw new Error(optJson.error ?? 'Failed to get registration options');
      }

      const credential = await startRegistration({ optionsJSON: optJson.data as Parameters<typeof startRegistration>[0]['optionsJSON'] });

      const verRes = await fetch('/api/auth/webauthn/register-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      });
      const verJson = await verRes.json() as ApiResponse;
      if (!verJson.success) throw new Error(verJson.error ?? 'Registration failed');

      setState('success');
      setMessage('Passkey registered successfully! You can now sign in with your passkey.');
      setTimeout(() => router.push(skipDest), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      if (msg.includes('cancelled') || msg.includes('NotAllowed')) {
        setMessage('Registration was cancelled. You can try again when ready.');
        setState('idle');
      } else {
        setMessage(msg);
        setState('error');
      }
    }
  }

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-4">
          <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Set up your passkey</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">Required for secure sign-in</p>
      </div>

      <Card>
        <div className="space-y-4">
          <div className="space-y-3">
            {[
              { icon: '🔒', title: 'No password needed', desc: 'Use your fingerprint, face, or device PIN instead' },
              { icon: '🛡️', title: 'Phishing-resistant', desc: 'Passkeys cannot be stolen or used on fake sites' },
              { icon: '📱', title: 'Works on this device', desc: 'Your passkey is stored securely on this device' },
            ].map(item => (
              <div key={item.title} className="flex gap-3 items-start">
                <span className="text-xl mt-0.5">{item.icon}</span>
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{item.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {notSupported ? (
            <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
              <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">Device not supported</p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                Your browser does not support passkeys. Please use a modern browser or device.
              </p>
            </div>
          ) : (
            <>
              {message && (
                <div className={`rounded-lg px-4 py-3 border text-sm ${
                  state === 'success'
                    ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                }`}>
                  {message}
                </div>
              )}

              {state !== 'success' && (
                <Button
                  className="w-full"
                  size="lg"
                  loading={state === 'registering'}
                  onClick={handleRegister}
                >
                  {state === 'registering' ? 'Follow your device prompt…' : 'Register passkey'}
                </Button>
              )}

              <button
                onClick={() => router.push(skipDest)}
                className="w-full text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors py-1"
              >
                Skip for now
              </button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
