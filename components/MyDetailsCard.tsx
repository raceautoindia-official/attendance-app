'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import EmployeeDocuments from '@/components/EmployeeDocuments';
import type { ApiResponse, Employee } from '@/lib/types';

type BankForm = {
  bank_account_name: string;
  bank_account_number: string;
  bank_ifsc: string;
  bank_name: string;
  pan_number: string;
  aadhaar_number: string;
};

/** Employee self-service: bank & identity details plus document uploads
 *  (PAN, Aadhaar, past experience certificates, …). */
export default function MyDetailsCard() {
  const qc = useQueryClient();
  // Only the fields the user actually touched; everything else falls through
  // to the saved profile values, so no state-syncing effect is needed.
  const [edits, setEdits] = useState<Partial<BankForm>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['profile', 'self'],
    queryFn: async () => {
      const res = await fetch('/api/profile');
      return res.json() as Promise<ApiResponse<{ employee: Employee }>>;
    },
  });
  const employee = data?.data?.employee;

  const form: BankForm = {
    bank_account_name: edits.bank_account_name ?? employee?.bank_account_name ?? '',
    bank_account_number: edits.bank_account_number ?? employee?.bank_account_number ?? '',
    bank_ifsc: edits.bank_ifsc ?? employee?.bank_ifsc ?? '',
    bank_name: edits.bank_name ?? employee?.bank_name ?? '',
    pan_number: edits.pan_number ?? employee?.pan_number ?? '',
    aadhaar_number: edits.aadhaar_number ?? employee?.aadhaar_number ?? '',
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      setMessage(null);
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed to save details');
    },
    onSuccess: () => {
      setMessage('Details saved ✓');
      setEdits({});
      qc.invalidateQueries({ queryKey: ['profile', 'self'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const set = (key: keyof BankForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEdits(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <Card>
      <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-4">
        My Details &amp; Documents
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Account Holder Name" value={form.bank_account_name} onChange={set('bank_account_name')} maxLength={100} />
            <Input label="Bank Account Number" value={form.bank_account_number} onChange={set('bank_account_number')} maxLength={24} />
            <Input label="IFSC Code" placeholder="SBIN0001234" value={form.bank_ifsc} onChange={set('bank_ifsc')} maxLength={11} />
            <Input label="Bank Name" value={form.bank_name} onChange={set('bank_name')} maxLength={100} />
            <Input label="PAN Number" placeholder="ABCDE1234F" value={form.pan_number} onChange={set('pan_number')} maxLength={10} />
            <Input label="Aadhaar Number" placeholder="12 digits" inputMode="numeric" value={form.aadhaar_number} onChange={set('aadhaar_number')} maxLength={12} />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
          {message && <p className="text-sm text-green-600 dark:text-green-400">{message}</p>}

          <div className="flex justify-end">
            <Button size="sm" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              Save Details
            </Button>
          </div>

          {employee && (
            <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-3">
                Documents (PAN, Aadhaar, experience certificates, …)
              </p>
              <EmployeeDocuments employeeId={employee.id} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
