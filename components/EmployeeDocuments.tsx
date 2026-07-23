'use client';

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse, DocumentType, EmployeeDocument } from '@/lib/types';

export const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  pan_card: 'PAN Card',
  aadhaar_card: 'Aadhaar Card',
  bank_proof: 'Bank Passbook / Cheque',
  experience_certificate: 'Experience Certificate',
  relieving_letter: 'Relieving Letter',
  education_certificate: 'Education Certificate',
  offer_letter: 'Offer Letter',
  other: 'Other',
};

const ACCEPTED = '.pdf,.jpg,.jpeg,.png,.webp';
const MAX_BYTES = 3 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

/** Upload + list + download (+ delete for super admins) of one employee's
 *  documents. Used in the admin employees page and the employee dashboard. */
export default function EmployeeDocuments({
  employeeId,
  canDelete = false,
}: {
  employeeId: number;
  canDelete?: boolean;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<DocumentType>('pan_card');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['employee-documents', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/documents`);
      return res.json() as Promise<ApiResponse<{ documents: EmployeeDocument[] }>>;
    },
  });
  const documents = data?.data?.documents ?? [];

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setError(null);
      if (file.size > MAX_BYTES) {
        throw new Error('File is too large — maximum 3 MB.');
      }
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
      const res = await fetch(`/api/employees/${employeeId}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_type: docType,
          title: title.trim() || DOC_TYPE_LABELS[docType],
          file_name: file.name,
          mime_type: file.type || 'application/pdf',
          data_base64: dataBase64,
        }),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Upload failed');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee-documents', employeeId] });
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await fetch(`/api/employees/${employeeId}/documents/${docId}`, { method: 'DELETE' });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Delete failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employee-documents', employeeId] }),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-3">
      {/* Upload row */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={docType}
          onChange={e => setDocType(e.target.value as DocumentType)}
          className={`${selectClass} sm:w-56`}
        >
          {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={150}
          placeholder="Title (optional)"
          className={`${selectClass} sm:flex-1`}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) uploadMutation.mutate(file);
          }}
        />
        <Button
          size="sm"
          loading={uploadMutation.isPending}
          onClick={() => fileRef.current?.click()}
        >
          Upload File
        </Button>
      </div>
      <p className="text-xs text-slate-400">PDF, JPG, PNG or WebP — up to 3 MB.</p>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : documents.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No documents uploaded yet.</p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-700/50 border border-slate-200 dark:border-slate-700 rounded-lg">
          {documents.map(doc => (
            <div key={doc.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{doc.title}</p>
                <p className="text-xs text-slate-400 truncate">
                  {doc.file_name} · {formatSize(doc.size_bytes)}
                  {doc.uploaded_by_name ? ` · by ${doc.uploaded_by_name}` : ''}
                </p>
              </div>
              <Badge variant="neutral">{DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}</Badge>
              <a
                href={`/api/employees/${employeeId}/documents/${doc.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
              >
                View
              </a>
              {canDelete && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={deleteMutation.isPending}
                  onClick={() => { if (confirm(`Delete "${doc.title}"?`)) deleteMutation.mutate(doc.id); }}
                >
                  Delete
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
