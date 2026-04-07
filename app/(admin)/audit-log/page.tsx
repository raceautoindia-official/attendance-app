'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import Table from '@/components/ui/Table';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import Input from '@/components/ui/Input';
import type { AuditLog, ApiResponse } from '@/lib/types';

type LogRow = AuditLog & { performed_by_name?: string | null };

const ENTITY_BADGE: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'neutral'> = {
  attendance: 'info',
  employee: 'success',
  passkey: 'warning',
  passkey_exemption: 'warning',
  employee_schedule: 'neutral',
  location: 'neutral',
  auth: 'danger',
};

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function AuditLogPage() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const sevenDaysAgo = format(new Date(Date.now() - 7 * 86400_000), 'yyyy-MM-dd');

  const [fromDate, setFromDate] = useState(sevenDaysAgo);
  const [toDate, setToDate] = useState(today);
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', { fromDate, toDate, entity, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      if (entity) params.set('entity', entity);
      const res = await fetch(`/api/audit-log?${params}`);
      return res.json() as Promise<ApiResponse<{ logs: LogRow[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const logs = data?.data?.logs ?? [];
  const pagination = data?.data?.pagination;

  function formatAction(action: string) {
    return action.replace(/_/g, ' ');
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Audit Log</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          label="From"
          type="date"
          value={fromDate}
          onChange={e => { setFromDate(e.target.value); setPage(1); }}
          className="w-40"
        />
        <Input
          label="To"
          type="date"
          value={toDate}
          onChange={e => { setToDate(e.target.value); setPage(1); }}
          className="w-40"
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Entity</label>
          <select
            value={entity}
            onChange={e => { setEntity(e.target.value); setPage(1); }}
            className={selectClass}
          >
            <option value="">All</option>
            <option value="attendance">Attendance</option>
            <option value="employee">Employee</option>
            <option value="passkey">Passkey</option>
            <option value="passkey_exemption">Passkey Exemption</option>
            <option value="employee_schedule">Schedule</option>
            <option value="location">Location</option>
            <option value="auth">Auth</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <Table
            columns={[
              {
                key: 'created_at',
                header: 'Time',
                render: r => {
                  const d = new Date((r as LogRow).created_at);
                  return (
                    <div>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{format(d, 'dd MMM yyyy')}</p>
                      <p className="text-xs text-slate-400">{format(d, 'HH:mm:ss')}</p>
                    </div>
                  );
                },
              },
              {
                key: 'entity',
                header: 'Entity',
                render: r => (
                  <Badge variant={ENTITY_BADGE[(r as LogRow).entity] ?? 'neutral'}>
                    {(r as LogRow).entity.replace(/_/g, ' ')}
                  </Badge>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                render: r => <span className="text-sm capitalize">{formatAction((r as LogRow).action)}</span>,
              },
              {
                key: 'performed_by',
                header: 'Performed By',
                render: r => {
                  const row = r as LogRow;
                  return (
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      {row.performed_by_name ?? (row.performed_by ? `ID ${row.performed_by}` : 'System')}
                    </span>
                  );
                },
              },
              {
                key: 'ip_address',
                header: 'IP',
                render: r => <span className="text-xs text-slate-400 font-mono">{(r as LogRow).ip_address ?? '—'}</span>,
              },
            ]}
            data={logs as object[]}
            onRowClick={r => {
              const id = (r as LogRow).id;
              setExpandedId(expandedId === id ? null : id);
            }}
            emptyMessage="No audit log entries found."
          />

          {/* Details panel */}
          {expandedId && (() => {
            const log = logs.find(l => l.id === expandedId);
            if (!log?.details) return null;
            return (
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Details</p>
                <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              </div>
            );
          })()}

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}
