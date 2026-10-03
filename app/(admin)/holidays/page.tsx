'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import Modal from '@/components/ui/Modal';
import { cn } from '@/lib/cn';
import type { ApiResponse } from '@/lib/types';

/**
 * Holiday Calendar — candidates in, observed holidays out.
 *
 * The important idea the UI has to convey: a row in this list does NOTHING on
 * its own. It becomes a real holiday only when a location is ticked, and that is
 * the moment attendance changes. The copy and the colours are built around that.
 */

interface Observance {
  location_id: number | null;
  location_name: string | null;
  is_observed: boolean;
  decided_by_name: string | null;
  decided_at: string | null;
}

interface Holiday {
  id: number;
  year: number;
  holiday_date: string;
  name: string;
  holiday_type: 'national' | 'regional' | 'company';
  state_code: string | null;
  needs_verification: boolean;
  source: 'bundled' | 'manual';
  notes: string | null;
  observances: Observance[];
  observed_anywhere: boolean;
}

interface LocationOption {
  id: number;
  name: string;
  state_code: string | null;
}

interface CalendarData {
  year: number;
  holidays: Holiday[];
  locations: LocationOption[];
  available_years: number[];
}

const TYPE_BADGE: Record<Holiday['holiday_type'], 'info' | 'warning' | 'neutral'> = {
  national: 'info',
  regional: 'warning',
  company: 'neutral',
};

function prettyDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export default function HolidaysPage() {
  const qc = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Date-confirmation prompt for a lunar holiday.
  const [confirming, setConfirming] = useState<{
    holiday: Holiday;
    locationId: number | null;
    date: string;
  } | null>(null);

  const [adding, setAdding] = useState(false);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '', notes: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['holidays', year],
    queryFn: async () => {
      const res = await fetch(`/api/holidays?year=${year}`);
      return res.json() as Promise<ApiResponse<CalendarData>>;
    },
  });

  const calendar = data?.data;
  // Memoised so the `stats` useMemo below has a stable dependency.
  const holidays = useMemo(() => calendar?.holidays ?? [], [calendar]);
  const locations = calendar?.locations ?? [];
  const availableYears = calendar?.available_years ?? [];

  const stats = useMemo(() => {
    const observed = holidays.filter(h => h.observed_anywhere).length;
    const unverified = holidays.filter(h => h.needs_verification).length;
    return { total: holidays.length, observed, unverified };
  }, [holidays]);

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/holidays/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      });
      const json = (await res.json()) as ApiResponse<unknown>;
      if (!json.success) throw new Error(json.error ?? 'Import failed');
      return json;
    },
    onSuccess: json => {
      setBanner({ kind: 'ok', text: json.message ?? 'Imported.' });
      qc.invalidateQueries({ queryKey: ['holidays', year] });
    },
    onError: (e: Error) => setBanner({ kind: 'err', text: e.message }),
  });

  const observeMutation = useMutation({
    mutationFn: async (vars: {
      holidayId: number;
      locationId: number | null;
      isObserved: boolean;
      confirmedDate?: string;
    }) => {
      const res = await fetch(`/api/holidays/${vars.holidayId}/observance`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: vars.locationId,
          is_observed: vars.isObserved,
          ...(vars.confirmedDate ? { confirmed_date: vars.confirmedDate } : {}),
        }),
      });
      const json = (await res.json()) as ApiResponse<unknown>;
      if (!json.success) throw new Error(json.error ?? 'Update failed');
      return json;
    },
    onSuccess: json => {
      setBanner({ kind: 'ok', text: json.message ?? 'Updated.' });
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ['holidays', year] });
    },
    onError: (e: Error) => setBanner({ kind: 'err', text: e.message }),
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/holidays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: newHoliday.date,
          name: newHoliday.name,
          type: 'company',
          notes: newHoliday.notes || null,
        }),
      });
      const json = (await res.json()) as ApiResponse<unknown>;
      if (!json.success) throw new Error(json.error ?? 'Could not add');
      return json;
    },
    onSuccess: json => {
      setBanner({ kind: 'ok', text: json.message ?? 'Added.' });
      setAdding(false);
      setNewHoliday({ date: '', name: '', notes: '' });
      qc.invalidateQueries({ queryKey: ['holidays', year] });
    },
    onError: (e: Error) => setBanner({ kind: 'err', text: e.message }),
  });

  function isObserved(h: Holiday, locationId: number | null) {
    return h.observances.some(o => o.location_id === locationId && o.is_observed);
  }

  function toggle(h: Holiday, locationId: number | null) {
    const next = !isObserved(h, locationId);
    // A lunar date is a placeholder — make the admin supply the real one.
    if (next && h.needs_verification) {
      setConfirming({ holiday: h, locationId, date: h.holiday_date });
      return;
    }
    observeMutation.mutate({ holidayId: h.id, locationId, isObserved: next });
  }

  const yearOptions = Array.from(
    new Set([...availableYears, currentYear, currentYear + 1, year]),
  ).sort();

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              Year
            </label>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              {yearOptions.map(y => (
                <option key={y} value={y}>
                  {y}
                  {availableYears.includes(y) ? '' : ' (no bundled list)'}
                </option>
              ))}
            </select>
          </div>

          <Button
            onClick={() => importMutation.mutate()}
            loading={importMutation.isPending}
            disabled={!availableYears.includes(year)}
          >
            Load {year} government list
          </Button>

          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add holiday
          </Button>

          <div className="ml-auto flex gap-5 text-sm">
            <div>
              <p className="text-slate-500 dark:text-slate-400">In calendar</p>
              <p className="text-lg font-semibold text-slate-800 dark:text-slate-100">{stats.total}</p>
            </div>
            <div>
              <p className="text-slate-500 dark:text-slate-400">Observed</p>
              <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{stats.observed}</p>
            </div>
            <div>
              <p className="text-slate-500 dark:text-slate-400">Need a date</p>
              <p className="text-lg font-semibold text-amber-600 dark:text-amber-400">{stats.unverified}</p>
            </div>
          </div>
        </div>

        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Nothing in this list affects attendance until you tick a location. Ticking
          marks the day a holiday for everyone working at that location; untick to
          reverse it.
        </p>
      </Card>

      {banner && (
        <div
          className={cn(
            'rounded-lg px-4 py-3 text-sm',
            banner.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
              : 'bg-red-50 text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{banner.text}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="shrink-0 text-xs underline opacity-70 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* Calendar */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : holidays.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            No holidays in the {year} calendar yet.
            {availableYears.includes(year)
              ? ` Click "Load ${year} government list" to bring in the published holidays as candidates.`
              : ' There is no bundled list for this year — add holidays with "Add holiday".'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto" padding={false}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60">
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200">Date</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200">Holiday</th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200">
                  Observed at
                </th>
              </tr>
            </thead>
            <tbody>
              {holidays.map(h => (
                <tr
                  key={h.id}
                  className={cn(
                    'border-b border-slate-100 last:border-0 dark:border-slate-700/60',
                    h.observed_anywhere && 'bg-emerald-50/40 dark:bg-emerald-950/10',
                  )}
                >
                  <td className="whitespace-nowrap px-3 py-2.5 align-top">
                    <p className="font-medium text-slate-800 dark:text-slate-100">
                      {prettyDate(h.holiday_date)}
                    </p>
                    {h.needs_verification && (
                      <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        date not confirmed
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-2.5 align-top">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{h.name}</span>
                      <Badge variant={TYPE_BADGE[h.holiday_type]}>{h.holiday_type}</Badge>
                      {h.state_code && <Badge variant="neutral">{h.state_code}</Badge>}
                      {h.source === 'manual' && <Badge variant="neutral">added by you</Badge>}
                    </div>
                    {h.notes && (
                      <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                        {h.notes}
                      </p>
                    )}
                  </td>

                  <td className="px-3 py-2.5 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      <LocationToggle
                        label="All locations"
                        active={isObserved(h, null)}
                        disabled={observeMutation.isPending}
                        onClick={() => toggle(h, null)}
                      />
                      {locations.map(l => (
                        <LocationToggle
                          key={l.id}
                          label={l.name}
                          active={isObserved(h, l.id)}
                          disabled={observeMutation.isPending || isObserved(h, null)}
                          onClick={() => toggle(h, l.id)}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Confirm-date prompt for lunar holidays */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Confirm the date"
      >
        {confirming && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              <strong className="text-slate-800 dark:text-slate-100">{confirming.holiday.name}</strong>{' '}
              follows a lunar calendar, so the date in the bundled list is only a
              placeholder. Check it against your state&apos;s official list before
              observing it — a wrong date rewrites attendance for everyone in scope.
            </p>
            <Input
              type="date"
              label="Actual date"
              value={confirming.date}
              onChange={e => setConfirming({ ...confirming, date: e.target.value })}
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                loading={observeMutation.isPending}
                onClick={() =>
                  observeMutation.mutate({
                    holidayId: confirming.holiday.id,
                    locationId: confirming.locationId,
                    isObserved: true,
                    confirmedDate: confirming.date,
                  })
                }
              >
                Confirm and observe
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Add a holiday by hand */}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a holiday">
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Adds a candidate to the calendar. It does not affect attendance until
            you tick a location for it.
          </p>
          <Input
            type="date"
            label="Date"
            value={newHoliday.date}
            onChange={e => setNewHoliday({ ...newHoliday, date: e.target.value })}
          />
          <Input
            label="Name"
            placeholder="e.g. Deepavali"
            value={newHoliday.name}
            onChange={e => setNewHoliday({ ...newHoliday, name: e.target.value })}
          />
          <Input
            label="Notes (optional)"
            value={newHoliday.notes}
            onChange={e => setNewHoliday({ ...newHoliday, notes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              loading={addMutation.isPending}
              disabled={!newHoliday.date || !newHoliday.name.trim()}
              onClick={() => addMutation.mutate()}
            >
              Add to calendar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function LocationToggle({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        active
          ? 'border-emerald-500 bg-emerald-500 text-white'
          : 'border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-emerald-500',
      )}
    >
      {active && <span className="mr-1">✓</span>}
      {label}
    </button>
  );
}
