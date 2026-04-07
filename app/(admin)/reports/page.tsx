'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import Card from '@/components/ui/Card';
import type { Employee, ApiResponse } from '@/lib/types';

interface SummaryRow {
  id: number;
  emp_id: string;
  name: string;
  total_days_present: number;
  total_days_late: number;
  total_days_absent: number;
  total_days_leave: number;
  total_minutes_worked: number;
  days_with_hours: number;
}

function minutesToHours(m: number) {
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function ReportsPage() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const firstOfMonth = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(today);
  const [employeeId, setEmployeeId] = useState('');
  const [empSearch, setEmpSearch] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);

  const { data: empData } = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=200');
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
  });
  const employees = empData?.data?.employees ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ['reports', 'summary', { fromDate, toDate, employeeId, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/reports/summary?${params}`);
      return res.json() as Promise<ApiResponse<{
        summary: SummaryRow[];
        pagination: { total: number; totalPages: number };
        period: { from_date: string; to_date: string };
      }>>;
    },
    enabled: !!(fromDate && toDate),
  });

  const summary = data?.data?.summary ?? [];
  const pagination = data?.data?.pagination;

  async function downloadFile(type: 'csv' | 'pdf') {
    setExporting(type);
    try {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (employeeId) params.set('employee_id', employeeId);
      const res = await fetch(`/api/reports/${type}?${params}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance_${fromDate}_to_${toDate}.${type}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setExporting(null);
    }
  }

  const _ = empSearch; // used for filtering below
  const filteredEmployees = employees.filter(e =>
    e.name.toLowerCase().includes(empSearch.toLowerCase()) || e.emp_id.includes(empSearch),
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <div className="flex flex-wrap gap-4 items-end">
          <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
          <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Employee (optional)</label>
            <div className="flex gap-2">
              <Input
                placeholder="Search…"
                value={empSearch}
                onChange={e => setEmpSearch(e.target.value)}
                className="w-40"
              />
              <select
                value={employeeId}
                onChange={e => { setEmployeeId(e.target.value); setPage(1); }}
                className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
              >
                <option value="">All employees</option>
                {filteredEmployees.map(e => (
                  <option key={e.id} value={e.id}>{e.name} ({e.emp_id})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2 sm:ml-auto">
            <Button
              variant="secondary"
              loading={exporting === 'csv'}
              onClick={() => downloadFile('csv')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </Button>
            <Button
              variant="secondary"
              loading={exporting === 'pdf'}
              onClick={() => downloadFile('pdf')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Export PDF
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary table */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <Table
            columns={[
              {
                key: 'name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as SummaryRow).name}</p>
                    <p className="text-xs text-slate-400">{(r as SummaryRow).emp_id}</p>
                  </div>
                ),
              },
              {
                key: 'total_days_present',
                header: 'Present',
                render: r => (
                  <span className="font-semibold text-green-600 dark:text-green-400">
                    {(r as SummaryRow).total_days_present}
                  </span>
                ),
              },
              {
                key: 'total_days_late',
                header: 'Late',
                render: r => (
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    {(r as SummaryRow).total_days_late}
                  </span>
                ),
              },
              {
                key: 'total_days_absent',
                header: 'Absent',
                render: r => (
                  <span className="font-semibold text-red-600 dark:text-red-400">
                    {(r as SummaryRow).total_days_absent}
                  </span>
                ),
              },
              { key: 'total_days_leave', header: 'Leave', render: r => String((r as SummaryRow).total_days_leave) },
              {
                key: 'total_minutes_worked',
                header: 'Total Hours',
                render: r => minutesToHours((r as SummaryRow).total_minutes_worked),
              },
              {
                key: 'avg_hours',
                header: 'Avg / Day',
                render: r => {
                  const row = r as SummaryRow;
                  if (row.days_with_hours === 0) return '—';
                  return minutesToHours(Math.round(row.total_minutes_worked / row.days_with_hours));
                },
              },
            ]}
            data={summary as object[]}
            emptyMessage="No data for the selected period."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}
    </div>
  );
}
