'use client';

import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import StatCard from '@/components/ui/StatCard';
import Badge from '@/components/ui/Badge';
import Table from '@/components/ui/Table';
import Card from '@/components/ui/Card';
import Spinner from '@/components/ui/Spinner';
import type { AttendanceRecord, AttendanceStatus, ApiResponse, Employee } from '@/lib/types';

type AttRow = AttendanceRecord & { employee_name?: string; emp_id?: string };

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', late: 'warning', absent: 'danger',
  early_departure: 'warning', leave: 'info', holiday: 'info',
};

const IST = 'Asia/Kolkata';
const IST_LOCALE = 'en-IN';
function toIST(d: Date | string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
}

export default function OverviewPage() {
  const today = format(new Date(), 'yyyy-MM-dd');

  const { data: empData, isLoading: empLoading } = useQuery({
    queryKey: ['employees', 'count'],
    queryFn: async () => {
      const res = await fetch('/api/employees?limit=1');
      return res.json() as Promise<ApiResponse<{ employees: Employee[]; pagination: { total: number } }>>;
    },
    refetchInterval: 60_000,
  });

  const { data: attData, isLoading: attLoading } = useQuery({
    queryKey: ['attendance', 'today-list', today],
    queryFn: async () => {
      const res = await fetch(`/api/attendance?from_date=${today}&to_date=${today}&limit=100`);
      return res.json() as Promise<ApiResponse<{ records: AttRow[]; pagination: { total: number } }>>;
    },
    refetchInterval: 60_000,
  });

  const totalEmployees = empData?.data?.pagination.total ?? 0;
  const records = attData?.data?.records ?? [];
  const present = records.filter(r => r.status === 'present' || r.status === 'late').length;
  const absent = records.filter(r => r.status === 'absent').length;
  const totalMinutes = records.reduce((s, r) => s + (r.total_minutes ?? 0), 0);
  const avgHours = records.length > 0 ? (totalMinutes / records.length / 60).toFixed(1) : '0';

  const isLoading = empLoading || attLoading;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Employees"
          value={totalEmployees}
          loading={isLoading}
          variant="info"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          }
        />
        <StatCard
          label="Present Today"
          value={present}
          loading={isLoading}
          variant="success"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Absent Today"
          value={absent}
          loading={isLoading}
          variant="danger"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Avg Hours Today"
          value={isLoading ? '…' : `${avgHours}h`}
          loading={isLoading}
          variant="warning"
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* Today's attendance table */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-200">Today's Attendance</h2>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Auto-refreshes every 60s
          </span>
        </div>

        {attLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <Table
            columns={[
              {
                key: 'employee_name',
                header: 'Employee',
                render: r => (
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-200">{(r as AttRow).employee_name ?? '—'}</p>
                    <p className="text-xs text-slate-400">{(r as AttRow).emp_id}</p>
                  </div>
                ),
              },
              {
                key: 'clock_in_utc',
                header: 'Clock In',
                render: r => toIST((r as AttRow).clock_in_utc),
              },
              {
                key: 'clock_out_utc',
                header: 'Clock Out',
                render: r => toIST((r as AttRow).clock_out_utc),
              },
              {
                key: 'total_minutes',
                header: 'Hours',
                render: r => {
                  const m = (r as AttRow).total_minutes;
                  return m != null ? `${Math.floor(m / 60)}h ${m % 60}m` : '—';
                },
              },
              {
                key: 'status',
                header: 'Status',
                render: r => (
                  <Badge variant={STATUS_BADGE[(r as AttRow).status]}>
                    {(r as AttRow).status.replace('_', ' ')}
                  </Badge>
                ),
              },
              {
                key: 'geofence_status',
                header: 'Location',
                render: r => {
                  const g = (r as AttRow).geofence_status;
                  if (g === 'not_required') return <span className="text-slate-400 text-xs">—</span>;
                  return <Badge variant={g === 'inside' ? 'success' : 'danger'}>{g}</Badge>;
                },
              },
            ]}
            data={records as object[]}
            emptyMessage="No attendance records for today."
          />
        )}
      </Card>
    </div>
  );
}
