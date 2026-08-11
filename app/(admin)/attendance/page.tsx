'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import Table from '@/components/ui/Table';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Badge from '@/components/ui/Badge';
import Pagination from '@/components/ui/Pagination';
import Spinner from '@/components/ui/Spinner';
import type { AttendanceRecord, AttendanceStatus, ApiResponse } from '@/lib/types';
import { formatDateOnly } from '@/lib/date';

type AttRow = AttendanceRecord & { employee_name?: string; emp_id?: string };

interface TimelineEvent {
  at_utc: string;
  kind: string;
  title: string;
  detail: string | null;
  latitude: number | null;
  longitude: number | null;
}
interface TimelineData {
  employee: { id: number; name: string; emp_id: string };
  work_date: string;
  events: TimelineEvent[];
  tracking: { points: number; first_utc: string | null; last_utc: string | null };
}

const TL_TZ = 'Asia/Kolkata';
const tlTime = (iso: string | null) =>
  iso ? formatInTimeZone(new Date(iso), TL_TZ, 'hh:mm:ss a') : '—';

// Colour per event kind: green for arrivals, red for enforced departures,
// amber for exceptions someone should read, blue for the rest.
const TL_TONE: Record<string, string> = {
  clock_in: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  clock_out: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  geofence_auto_clockout: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  live_tracking_signal_lost: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  marked_absent: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  clock_in_outside_fence: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  off_site_clock_in_rejected: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

const STATUS_BADGE: Record<AttendanceStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', late: 'warning', absent: 'danger',
  early_departure: 'warning', leave: 'info', holiday: 'info',
};

const IST_LOCALE = 'en-IN';
const TZ = 'Asia/Kolkata';

function toIST(d: Date | string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(IST_LOCALE, { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
}
// UTC timestamp -> "yyyy-MM-ddTHH:mm" string in IST, for the datetime-local
// input. Always IST regardless of the admin's browser timezone.
function toISTInput(d: Date | string | null | undefined) {
  if (!d) return '';
  return formatInTimeZone(new Date(d), TZ, "yyyy-MM-dd'T'HH:mm");
}
// The datetime-local value the admin typed is IST -> convert back to a UTC ISO
// string for storage.
function istInputToUtcISO(local: string): string {
  return fromZonedTime(local, TZ).toISOString();
}

const editSchema = z.object({
  clock_in_utc: z.string().optional(),
  clock_out_utc: z.string().optional(),
  status: z.enum(['present', 'late', 'absent', 'early_departure', 'leave', 'holiday']),
  notes: z.string().max(500).optional(),
});
type EditForm = z.infer<typeof editSchema>;

const selectClass = 'block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function AttendancePage() {
  // One employee's whole day, told in order — every clock event, warning,
  // exception and decision between the 07:00 boundaries.
  const [dayView, setDayView] = useState<{ employeeId: number; date: string; name: string } | null>(null);
  const { data: timelineData, isLoading: timelineLoading } = useQuery({
    queryKey: ['timeline', dayView?.employeeId, dayView?.date],
    enabled: !!dayView,
    queryFn: async () => {
      const res = await fetch(`/api/employees/${dayView!.employeeId}/timeline?date=${dayView!.date}`);
      return res.json() as Promise<ApiResponse<TimelineData>>;
    },
  });
  const qc = useQueryClient();
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [empSearch, setEmpSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editTarget, setEditTarget] = useState<AttRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['attendance', { fromDate, toDate, empSearch, page }],
    queryFn: async () => {
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate, page: String(page), limit: '25' });
      if (empSearch) params.set('employee_search', empSearch);
      const res = await fetch(`/api/attendance?${params}`);
      return res.json() as Promise<ApiResponse<{ records: AttRow[]; pagination: { total: number; totalPages: number } }>>;
    },
  });

  const records = data?.data?.records ?? [];
  const pagination = data?.data?.pagination;

  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) });

  const editMutation = useMutation({
    mutationFn: async ({ id, values }: { id: number; values: EditForm }) => {
      // Send the time fields even when blanked, as an explicit null — otherwise
      // clearing a wrongly-recorded clock-out silently kept the old value.
      const body: Record<string, unknown> = {
        status: values.status,
        notes: values.notes,
        clock_in_utc: values.clock_in_utc ? istInputToUtcISO(values.clock_in_utc) : null,
        clock_out_utc: values.clock_out_utc ? istInputToUtcISO(values.clock_out_utc) : null,
      };
      const res = await fetch(`/api/attendance/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as ApiResponse;
      if (!json.success) throw new Error(json.error ?? 'Failed');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance'] }); setEditTarget(null); },
  });

  function openEdit(row: AttRow) {
    setEditTarget(row);
    editForm.reset({
      clock_in_utc: toISTInput(row.clock_in_utc),
      clock_out_utc: toISTInput(row.clock_out_utc),
      status: row.status,
      notes: row.notes ?? '',
    });
  }

  function mapsLink(lat?: number | null, lng?: number | null) {
    if (!lat || !lng) return null;
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <Input label="From" type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }} className="w-36" />
        <Input label="To" type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }} className="w-36" />
        <Input
          label="Employee"
          placeholder="Search name…"
          value={empSearch}
          onChange={e => { setEmpSearch(e.target.value); setPage(1); }}
          className="sm:w-48"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
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
              { key: 'work_date', header: 'Date', render: r => formatDateOnly((r as AttRow).work_date) },
              {
                key: 'clock_in_utc',
                header: 'In (IST)',
                render: r => {
                  const row = r as AttRow;
                  // The day's FIRST login is "the" login. On a multi-session
                  // day the row's clock_in_utc moves with each re-open, and
                  // showing that here was the complaint: "I logged in at 9:09
                  // but it shows the in-between login everywhere".
                  const first = row.first_clock_in_utc ?? row.clock_in_utc;
                  const sessionDiffers =
                    row.first_clock_in_utc != null &&
                    row.clock_in_utc != null &&
                    String(row.first_clock_in_utc) !== String(row.clock_in_utc);
                  return (
                    <div>
                      <p>{toIST(first)}</p>
                      {sessionDiffers && (
                        <p className="text-xs text-slate-400" title="Start of the currently open session">
                          session {toIST(row.clock_in_utc)}
                        </p>
                      )}
                    </div>
                  );
                },
              },
              { key: 'clock_out_utc', header: 'Out (IST)', render: r => toIST((r as AttRow).clock_out_utc) },
              {
                key: 'total_minutes',
                header: 'Hours',
                render: r => {
                  const row = r as AttRow;
                  // Approved permission hours top the worked time back up to
                  // the shift length; show what was actually clocked beneath.
                  // On a multi-session day still in progress, total_minutes is
                  // NULL — banked_minutes holds the finished sessions.
                  const banked = Number(row.banked_minutes ?? 0);
                  const worked = row.total_minutes ?? (banked > 0 ? banked : null);
                  const credited = row.credited_minutes ?? worked;
                  if (credited == null) return '—';
                  const permission = Number(row.permission_minutes ?? 0);
                  const sessions = Number(row.session_count ?? 1);
                  const inProgress = row.total_minutes == null && banked > 0;
                  return (
                    <div>
                      <p className="text-slate-800 dark:text-slate-200">
                        {`${Math.floor(credited / 60)}h ${credited % 60}m`}
                        {inProgress && <span className="text-xs text-slate-400"> so far</span>}
                      </p>
                      {permission > 0 && (
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          {`${Math.floor((worked ?? 0) / 60)}h ${(worked ?? 0) % 60}m worked + ${Math.floor(permission / 60)}h ${permission % 60}m permission`}
                        </p>
                      )}
                      {sessions > 1 && (
                        <p className="text-xs text-slate-400">{sessions} sessions</p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'status',
                header: 'Status',
                render: r => {
                  const row = r as AttRow;
                  return (
                    <div>
                      <Badge variant={STATUS_BADGE[row.status]}>{row.status.replace('_', ' ')}</Badge>
                      {/* Clocked in away from the work site, having given a
                          reason. Shown next to the status because it is the one
                          thing about the day an admin has to actually read: the
                          fence was waived on the employee's own say-so. */}
                      {row.out_of_fence_reason && (
                        <p
                          className="mt-1 text-xs text-amber-600 dark:text-amber-400"
                          title={row.out_of_fence_reason}
                        >
                          Off-site: {row.out_of_fence_reason}
                        </p>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'day_view',
                header: 'Day',
                render: r => {
                  const row = r as AttRow;
                  return (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDayView({
                        employeeId: row.employee_id,
                        date: row.work_date,
                        name: row.employee_name ?? row.emp_id ?? String(row.employee_id),
                      })}
                    >
                      View
                    </Button>
                  );
                },
              },
              {
                key: 'clock_in_lat',
                header: 'Location',
                render: r => {
                  const link = mapsLink((r as AttRow).clock_in_lat, (r as AttRow).clock_in_lng);
                  if (!link) return <span className="text-slate-400">—</span>;
                  return (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs">
                      View map ↗
                    </a>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                render: r => (
                  <Button size="sm" variant="ghost" onClick={() => openEdit(r as AttRow)}>Edit</Button>
                ),
              },
            ]}
            data={records as object[]}
            emptyMessage="No attendance records for the selected date range."
          />

          {pagination && pagination.totalPages > 1 && (
            <Pagination page={page} totalPages={pagination.totalPages} onPageChange={setPage} />
          )}
        </>
      )}

      {/* Edit modal */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Attendance Record">
        {editTarget && (
          <form onSubmit={editForm.handleSubmit(v => editMutation.mutate({ id: editTarget.id, values: v }))} className="space-y-4">
            <div className="text-sm text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700/50 rounded-lg px-3 py-2">
              <span className="font-medium text-slate-700 dark:text-slate-300">{editTarget.employee_name}</span>
              {' — '}{formatDateOnly(editTarget.work_date)}
            </div>

            <Input label="Clock In (IST)" type="datetime-local" {...editForm.register('clock_in_utc')} />
            <Input label="Clock Out (IST)" type="datetime-local"
              helper="Clearing this reopens the day — the employee shows as still clocked in"
              {...editForm.register('clock_out_utc')} />

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Status</label>
              <select {...editForm.register('status')} className={selectClass}>
                {(['present', 'late', 'absent', 'early_departure', 'leave', 'holiday'] as AttendanceStatus[]).map(s => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Notes</label>
              <textarea
                {...editForm.register('notes')}
                rows={2}
                className="block w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {editMutation.isError && (
              <p className="text-sm text-red-500">{(editMutation.error as Error).message}</p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>Cancel</Button>
              <Button type="submit" loading={editMutation.isPending}>Save</Button>
            </div>
          </form>
        )}
      </Modal>
      {/* The day, as a story. */}
      <Modal
        open={!!dayView}
        onClose={() => setDayView(null)}
        title={dayView ? `${dayView.name} — ${dayView.date}` : ''}
        size="lg"
      >
        {timelineLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : timelineData?.data ? (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {timelineData.data.tracking.points > 0
                ? `Phone reported ${timelineData.data.tracking.points} fixes, ${tlTime(timelineData.data.tracking.first_utc)} – ${tlTime(timelineData.data.tracking.last_utc)}.`
                : 'The phone sent no location fixes this day.'}
            </p>
            {timelineData.data.events.length === 0 ? (
              <p className="py-4 text-sm text-slate-500 dark:text-slate-400">
                No recorded events for this day.
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/50">
                {timelineData.data.events.map((ev, i) => (
                  <div key={`${ev.at_utc}-${i}`} className="flex items-start gap-3 py-2">
                    <span className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${TL_TONE[ev.kind] ?? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                        {ev.title}
                        <span className="ml-2 text-xs font-normal tabular-nums text-slate-400">
                          {tlTime(ev.at_utc)}
                        </span>
                      </p>
                      {ev.detail && (
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{ev.detail}</p>
                      )}
                    </div>
                    {ev.latitude != null && ev.longitude != null && (
                      <a
                        href={`https://www.google.com/maps?q=${ev.latitude},${ev.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 flex-shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Map ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="py-4 text-sm text-red-500">Could not load the day.</p>
        )}
      </Modal>
    </div>
  );
}
