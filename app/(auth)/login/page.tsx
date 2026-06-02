'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { storeUser } from '@/lib/user';
import type { ApiResponse, Employee } from '@/lib/types';

const schema = z.object({
  emp_id: z.string().min(1, 'Employee ID is required'),
  pin: z.string().length(6, 'PIN must be exactly 6 digits').regex(/^\d+$/, 'PIN must be numeric'),
});

type FormValues = z.infer<typeof schema>;

type LoginData = {
  requiresWebAuthn?: boolean;
  requiresPasskeySetup?: boolean;
  employee?: Employee & { name: string };
};

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [webAuthnPending, setWebAuthnPending] = useState(false);
  const [photoProofEnabled, setPhotoProofEnabled] = useState(false);
  const [photoProof, setPhotoProof] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  async function runWebAuthn() {
    setWebAuthnPending(true);
    setError(null);
    try {
      const optRes = await fetch('/api/auth/webauthn/authenticate');
      const optJson = await optRes.json() as ApiResponse<object>;
      if (!optJson.success || !optJson.data) {
        throw new Error(optJson.error ?? 'Failed to get authentication options');
      }

      const credential = await startAuthentication({
        optionsJSON: optJson.data as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });

      const verRes = await fetch('/api/auth/webauthn/authenticate-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      });
      const verJson = await verRes.json() as ApiResponse<{ employee: Employee & { name: string } }>;
      if (!verJson.success || !verJson.data?.employee) {
        throw new Error(verJson.error ?? 'WebAuthn verification failed');
      }

      const emp = verJson.data.employee;
      storeUser({ id: emp.id, emp_id: emp.emp_id, name: emp.name, role: emp.role });
      router.push(emp.role === 'employee' ? '/dashboard' : '/overview');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'WebAuthn authentication failed';
      if (msg.includes('cancelled') || msg.includes('NotAllowed')) {
        setError('Authentication was cancelled. Please try again.');
      } else {
        setError(msg);
      }
    } finally {
      setWebAuthnPending(false);
    }
  }

  async function onSubmit(values: FormValues) {
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          photo_proof: photoProofEnabled ? photoProof ?? undefined : undefined,
        }),
      });
      const json = await res.json() as ApiResponse<LoginData>;

      if (!json.success) {
        setError(json.error ?? 'Login failed');
        return;
      }

      const data = json.data;

      if (data?.requiresPasskeySetup) {
        setError('Passkey setup required. Please contact your administrator to grant initial access.');
        return;
      }

      if (data?.requiresWebAuthn) {
        await runWebAuthn();
        return;
      }

      const emp = data?.employee;
      if (emp) {
        storeUser({ id: emp.id, emp_id: emp.emp_id, name: emp.name, role: emp.role });
        if (emp.role === 'employee') {
          router.push('/register-passkey');
        } else {
          router.push('/overview');
        }
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <span className="text-lg font-bold text-slate-900 dark:text-slate-100">Attendance</span>
        </div>
        <ThemeToggle />
      </div>

      <Card>
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Sign in</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Enter your employee ID and PIN</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Employee ID"
            placeholder="e.g. EMP001"
            autoComplete="username"
            autoFocus
            {...register('emp_id')}
            error={errors.emp_id?.message}
          />
          <Input
            label="PIN"
            type="password"
            placeholder="6-digit PIN"
            maxLength={6}
            inputMode="numeric"
            autoComplete="current-password"
            {...register('pin')}
            error={errors.pin?.message}
          />
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={photoProofEnabled}
                onChange={e => {
                  setPhotoProofEnabled(e.target.checked);
                  if (!e.target.checked) setPhotoProof(null);
                }}
              />
              Add photo proof (optional)
            </label>
            {photoProofEnabled && (
              <div className="mt-2 space-y-2">
                <input
                  type="file"
                  accept="image/*"
                  capture="user"
                  onChange={async e => {
                    const f = e.target.files?.[0];
                    if (!f) {
                      setPhotoProof(null);
                      return;
                    }
                    const data = await new Promise<string>((resolve, reject) => {
                      const r = new FileReader();
                      r.onload = () => resolve(String(r.result ?? ''));
                      r.onerror = () => reject(new Error('Unable to read image'));
                      r.readAsDataURL(f);
                    });
                    setPhotoProof(data);
                  }}
                  className="block w-full text-xs text-slate-500"
                />
                {photoProof && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoProof} alt="Login photo proof" className="h-20 w-20 rounded-md object-cover border border-slate-200 dark:border-slate-700" />
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-3">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            loading={isSubmitting || webAuthnPending}
            size="lg"
          >
            {webAuthnPending ? 'Waiting for passkey...' : 'Sign in'}
          </Button>
        </form>
      </Card>

      <p className="text-center text-xs text-slate-400">
        Secured with passkey authentication
      </p>
    </div>
  );
}
