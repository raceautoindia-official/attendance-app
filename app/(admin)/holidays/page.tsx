'use client';

/**
 * /holidays — the holiday calendar, as a calendar.
 *
 * The old page was a table, and a table is the wrong shape for this: the
 * question an administrator actually has is "what does this month look like",
 * and a list of dates makes them assemble that in their head. A year grid
 * answers it at a glance, and clustering — three closures in one week, a
 * fortnight with none — is visible instead of inferred.
 *
 * THE DISTINCTION THE WHOLE PAGE TURNS ON, carried over from the old design
 * because it is the best thing about it:
 *
 *   A CANDIDATE is a date somebody suggested. It does nothing. It changes no
 *   working day, no required hours, nobody's attendance.
 *
 *   An OBSERVED holiday is one this company actually closes for, at a named
 *   site or everywhere. Only this affects anything.
 *
 * That is why importing a whole country speculatively is safe, and why the
 * grid shows the two states differently rather than listing "holidays".
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Input from '@/components/ui/Input';
import Spinner from '@/components/ui/Spinner';
import Drawer from '@/components/ui/Drawer';
import { cn } from '@/lib/cn';
import type { ApiResponse } from '@/lib/types';

interface Observance { location_id: number | null; location_name: string | null; is_observed: boolean }
interface Holiday {
  id: number; year: number; holiday_date: string; name: string;
  holiday_type: string; state_code: string | null; country_code?: string;
  needs_verification: boolean; source: string; notes: string | null;
  observances: Observance[]; observed_anywhere: boolean;
}
interface LocationOption { id: number; name: string }
interface CalendarData {
  year: number; holidays: Holiday[]; locations: LocationOption[]; available_years: number[];
}
interface CountryOption { code: string; name: string }
interface Tracked {
  id: number; country_code: string; country_name: string;
  region_code: string | null; region_name: string | null; is_active: boolean;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not load');
  return json.data as T;
}
async function send(url: string, body: unknown, method = 'POST'): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: ApiResponse<unknown> = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Could not save');
  return json.data;
}

/**
 * Correcting a holiday, or removing it.
 *
 * The calendar could only be added to. A date typed wrong stayed on the list
 * for good, and the nearest thing to deleting it was leaving it unobserved and
 * hoping nobody wondered what it was.
 *
 * Folded away, because reading the calendar is the common act and editing it
 * is not - but folded away HERE, on the date itself, rather than on another
 * screen somebody has to be told about.
 */
function CorrectHoliday({ holiday, onDone, onError }: {
  holiday: Holiday;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(holiday.name);
  const [date, setDate] = useState(holiday.holiday_date);
  const [notes, setNotes] = useState(holiday.notes ?? '');
  const [seeded, setSeeded] = useState(holiday.id);

  // A different date opened in the same drawer: start from its values.
  if (holiday.id !== seeded) {
    setSeeded(holiday.id);
    setName(holiday.name);
    setDate(holiday.holiday_date);
    setNotes(holiday.notes ?? '');
    setOpen(false);
  }

  const save = useMutation({
    mutationFn: () => send(`/api/holidays/${holiday.id}`, {
      name: name.trim(),
      date,
      notes: notes.trim() || null,
    }, 'PATCH'),
    onSuccess: () => onDone('Date corrected.'),
    onError: (e: Error) => onError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => send(`/api/holidays/${holiday.id}`, undefined, 'DELETE'),
    onSuccess: () => onDone('Date removed from the calendar.'),
    onError: (e: Error) => onError(e.message),
  });

  const changed = name.trim() !== holiday.name
    || date !== holiday.holiday_date
    || notes.trim() !== (holiday.notes ?? '');

  return (
    <div className="border-t border-slate-200 pt-3 dark:border-slate-700">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
        >
          Correct or remove this date
        </button>
      ) : (
        <div className="space-y-3">
          <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
          <div>
            <Input label="Date" type="date" value={date}
              onChange={e => setDate(e.target.value)}
              disabled={holiday.observed_anywhere} />
            {holiday.observed_anywhere && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                The date cannot be moved while a site observes it - the closure is
                already on that day, and may be inside a month already closed. Untick
                the sites above, move it, then tick them again.
              </p>
            )}
          </div>
          <Input label="Note (optional)" value={notes}
            onChange={e => setNotes(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              loading={save.isPending}
              disabled={!changed || !name.trim()}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <div className="ml-auto">
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  if (confirm(`Remove "${holiday.name}" from the calendar?`)) remove.mutate();
                }}
              >
                Remove
              </Button>
            </div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Renaming changes a label and moves nobody&rsquo;s hours. Removing is only
            possible while this closes nothing anywhere.
          </p>
        </div>
      )}
    </div>
  );
}

export default function HolidaysPage() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const [open, setOpen] = useState<Holiday | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterCountry, setFilterCountry] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['holidays', year],
    queryFn: () => getJson<CalendarData>(`/api/holidays?year=${year}`),
  });
  const { data: catalog } = useQuery({
    queryKey: ['holiday-catalog'],
    queryFn: () => getJson<{ countries: CountryOption[]; tracked: Tracked[] }>(
      '/api/holidays/catalog?countries=1'),
  });

  const holidays = useMemo(() => {
    const all = data?.holidays ?? [];
    return filterCountry ? all.filter(h => (h.country_code ?? 'IN') === filterCountry) : all;
  }, [data, filterCountry]);

  const locations = data?.locations ?? [];
  const tracked = (catalog?.tracked ?? []).filter(t => t.is_active);

  const byDate = useMemo(() => {
    const m = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const list = m.get(h.holiday_date) ?? [];
      list.push(h);
      m.set(h.holiday_date, list);
    }
    return m;
  }, [holidays]);

  const stats = useMemo(() => ({
    total: holidays.length,
    observed: holidays.filter(h => h.observed_anywhere).length,
    unverified: holidays.filter(h => h.needs_verification).length,
  }), [holidays]);

  const after = (m: string) => { setError(null); setNotice(m); qc.invalidateQueries({ queryKey: ['holidays'] }); };

  const observe = useMutation({
    mutationFn: (v: { holidayId: number; locationId: number | null; isObserved: boolean }) =>
      // PUT, not the helper's default POST: the route only exports PUT, so
      // this toggle - the act that actually applies a holiday - was answering
      // 405 after the page was rewritten around a POST helper.
      send(`/api/holidays/${v.holidayId}/observance`,
        { location_id: v.locationId, is_observed: v.isObserved }, 'PUT'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
    onError: (e: Error) => setError(e.message),
  });
  const importLibrary = useMutation({
    mutationFn: (v: { country_code: string; region_code: string | null }) =>
      send('/api/holidays/catalog', { action: 'import', ...v, year }),
    onSuccess: (d) => {
      const r = d as { found: number; inserted: number; skipped: number; notes: string[] };
      after(`Found ${r.found}, added ${r.inserted} as candidates, left ${r.skipped} alone.`
        + (r.notes[0] ? ` ${r.notes[0]}` : ''));
      qc.invalidateQueries({ queryKey: ['holiday-catalog'] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const importBundled = useMutation({
    mutationFn: () => send('/api/holidays/import', { year }),
    onSuccess: () => after('Bundled dataset imported as candidates.'),
    onError: (e: Error) => setError(e.message),
  });

  // Re-read from the refreshed list so ticking a site updates the panel.
  const openHoliday = open ? holidays.find(h => h.id === open.id) ?? open : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Holiday Calendar</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            A date here does nothing until you say your company closes for it. Import
            freely &mdash; candidates change no working day and nobody&rsquo;s hours.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setManaging(true)}>Countries</Button>
          <Button onClick={() => { setError(null); setAdding(true); }}>Add a date</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 text-xs underline">Dismiss</button>
        </div>
      )}

      {/* Period and filters, in their own bar. */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Year</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setYear(y => y - 1)}
                className="h-10 w-9 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                aria-label="Previous year"
              >&lsaquo;</button>
              <span className="w-16 text-center text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {year}
              </span>
              <button
                onClick={() => setYear(y => y + 1)}
                className="h-10 w-9 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                aria-label="Next year"
              >&rsaquo;</button>
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Country</span>
            <select
              value={filterCountry}
              onChange={e => setFilterCountry(e.target.value)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">All countries</option>
              {tracked.map(t => (
                <option key={t.id} value={t.country_code}>
                  {t.country_name}{t.region_name ? ` (${t.region_name})` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex flex-wrap items-end gap-2">
            {tracked.map(t => (
              <Button
                key={t.id}
                variant="secondary"
                loading={importLibrary.isPending}
                onClick={() => importLibrary.mutate({
                  country_code: t.country_code, region_code: t.region_code,
                })}
              >
                Load {t.country_code}{t.region_code ? `-${t.region_code}` : ''} {year}
              </Button>
            ))}
            <Button data-tour="holiday-import" variant="secondary" loading={importBundled.isPending}
              onClick={() => importBundled.mutate()}>
              Load bundled India
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
          <span className="text-slate-600 dark:text-slate-300">
            <strong className="tabular-nums">{stats.total}</strong> dates
          </span>
          <span className="text-emerald-700 dark:text-emerald-400">
            <strong className="tabular-nums">{stats.observed}</strong> observed somewhere
          </span>
          <span className="text-slate-500 dark:text-slate-400">
            <strong className="tabular-nums">{stats.total - stats.observed}</strong> candidates, doing nothing
          </span>
          {stats.unverified > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              <strong className="tabular-nums">{stats.unverified}</strong> unverified
            </span>
          )}
        </div>
      </Card>

      {isLoading ? (
        <Card><div className="flex justify-center py-10"><Spinner /></div></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {MONTHS.map((label, m) => (
            <MonthGrid
              key={m} year={year} month={m} label={label}
              byDate={byDate} onPick={h => { setError(null); setOpen(h); }}
            />
          ))}
        </div>
      )}

      {/* ---- one date ---- */}
      <Drawer
        open={openHoliday !== null}
        onClose={() => setOpen(null)}
        title={openHoliday?.name}
        description={openHoliday
          ? `${openHoliday.holiday_date} · ${openHoliday.holiday_type}`
            + ` · from ${sourceLabel(openHoliday.source)}`
          : ''}
        size="md"
      >
        {openHoliday && (
          <div className="space-y-4">
            <div className={cn(
              'rounded-lg border px-3 py-2 text-xs',
              openHoliday.observed_anywhere
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
                : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300',
            )}>
              {openHoliday.observed_anywhere
                ? 'This is a real closure. It removes the day from required hours wherever it is ticked below.'
                : 'A candidate. Nothing is closed and no hours change until a site is ticked.'}
            </div>

            {openHoliday.needs_verification && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                Unverified &mdash; this date was computed or imported, not confirmed by anybody here.
                Regional and lunar dates in particular are worth checking against an official notice.
              </p>
            )}

            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Who closes
              </h4>
              <div className="space-y-1">
                <ObservanceRow
                  label="Everywhere" sub="Every site, company-wide"
                  checked={openHoliday.observances.some(o => o.location_id === null && o.is_observed)}
                  pending={observe.isPending}
                  onChange={v => observe.mutate({
                    holidayId: openHoliday.id, locationId: null, isObserved: v })}
                />
                {locations.map(l => (
                  <ObservanceRow
                    key={l.id} label={l.name} sub="This site only"
                    checked={openHoliday.observances.some(o => o.location_id === l.id && o.is_observed)}
                    pending={observe.isPending}
                    onChange={v => observe.mutate({
                      holidayId: openHoliday.id, locationId: l.id, isObserved: v })}
                  />
                ))}
              </div>
            </div>

            {openHoliday.notes && (
              <p className="text-xs text-slate-500 dark:text-slate-400">{openHoliday.notes}</p>
            )}

            <CorrectHoliday
              holiday={openHoliday}
              onDone={m => { setOpen(null); after(m); }}
              onError={setError}
            />
          </div>
        )}
      </Drawer>

      <AddDrawer open={adding} onClose={() => setAdding(false)} year={year}
        onSaved={() => { setAdding(false); after('Date added as a candidate.'); }}
        onError={setError} />

      <CountriesDrawer open={managing} onClose={() => setManaging(false)}
        countries={catalog?.countries ?? []} tracked={catalog?.tracked ?? []}
        onChanged={() => qc.invalidateQueries({ queryKey: ['holiday-catalog'] })}
        onError={setError} />
    </div>
  );
}

function sourceLabel(s: string): string {
  if (s === 'library') return 'the holiday library';
  if (s === 'bundled') return 'the bundled dataset';
  return 'a person here';
}

function ObservanceRow({
  label, sub, checked, pending, onChange,
}: {
  label: string; sub: string; checked: boolean; pending: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <input
        type="checkbox" checked={checked} disabled={pending}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
      <span className="min-w-0">
        <span className="block text-sm text-slate-800 dark:text-slate-200">{label}</span>
        <span className="block text-[11px] text-slate-500 dark:text-slate-400">{sub}</span>
      </span>
    </label>
  );
}

/** One month. Weeks start Monday, which is how a working week is read. */
function MonthGrid({
  year, month, label, byDate, onPick,
}: {
  year: number; month: number; label: string;
  byDate: Map<string, Holiday[]>; onPick: (h: Holiday) => void;
}) {
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // getUTCDay is 0 for Sunday; shift so Monday is 0.
  const lead = (first.getUTCDay() + 6) % 7;

  const cells: Array<{ day: number; iso: string; items: Holiday[] } | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, items: byDate.get(iso) ?? [] });
  }

  const inMonth = cells.filter(Boolean).flatMap(c => c!.items);

  return (
    <Card padding={false}>
      <div className="flex items-baseline justify-between px-3 pt-2.5">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</h3>
        {inMonth.length > 0 && (
          <span className="text-[11px] tabular-nums text-slate-400">{inMonth.length}</span>
        )}
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-2 pb-1 pt-2">
        {DOW.map((d, i) => (
          <div key={i} className="pb-1 text-center text-[10px] font-medium text-slate-400">{d}</div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={i} />;
          const observed = c.items.some(h => h.observed_anywhere);
          const candidate = c.items.length > 0 && !observed;
          return (
            <button
              key={i}
              disabled={c.items.length === 0}
              onClick={() => c.items[0] && onPick(c.items[0])}
              title={c.items.map(h => h.name).join(', ')}
              className={cn(
                'relative aspect-square rounded text-[11px] tabular-nums transition-colors',
                c.items.length === 0 && 'text-slate-400 dark:text-slate-600',
                // Observed and candidate have to be distinguishable without
                // relying on colour alone, so the observed day is also filled
                // and bold while a candidate is only outlined.
                observed && 'bg-emerald-500 font-semibold text-white hover:bg-emerald-600',
                candidate && 'border border-dashed border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40',
              )}
            >
              {c.day}
              {c.items.length > 1 && (
                <span className="absolute right-0.5 top-0 text-[8px]">{c.items.length}</span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function AddDrawer({
  open, onClose, year, onSaved, onError,
}: {
  open: boolean; onClose: () => void; year: number;
  onSaved: () => void; onError: (m: string) => void;
}) {
  const [date, setDate] = useState(`${year}-01-01`);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');

  const save = useMutation({
    mutationFn: () => send('/api/holidays', {
      holiday_date: date, name, notes: notes || null, holiday_type: 'company',
    }),
    onSuccess: () => { setName(''); setNotes(''); onSaved(); },
    onError: (e: Error) => onError(e.message),
  });

  return (
    <Drawer
      open={open} onClose={onClose} title="Add a date"
      description="Added as a candidate, like everything else. Tick a site afterwards to make it real."
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            Add
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Input label="Date" type="date" required value={date} onChange={e => setDate(e.target.value)} />
        <Input label="Name" required value={name} onChange={e => setName(e.target.value)}
          helper="What it is called, e.g. Founder's Day." />
        <Input label="Note" value={notes} onChange={e => setNotes(e.target.value)}
          helper="Optional. Why this date is here, for whoever reads it next year." />
      </div>
    </Drawer>
  );
}

function CountriesDrawer({
  open, onClose, countries, tracked, onChanged, onError,
}: {
  open: boolean; onClose: () => void;
  countries: CountryOption[]; tracked: Tracked[];
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');

  const { data: regions } = useQuery({
    queryKey: ['holiday-regions', country],
    enabled: country.length === 2,
    queryFn: () => getJson<{ regions: Array<{ code: string; name: string }> }>(
      `/api/holidays/catalog?country=${country}`).then(d => d.regions),
  });

  const add = useMutation({
    mutationFn: () => send('/api/holidays/catalog', {
      action: 'track', country_code: country, region_code: region || null }),
    onSuccess: () => { setCountry(''); setRegion(''); onChanged(); },
    onError: (e: Error) => onError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => send('/api/holidays/catalog', { action: 'untrack', id }),
    onSuccess: onChanged,
    onError: (e: Error) => onError(e.message),
  });

  return (
    <Drawer
      open={open} onClose={onClose} title="Countries you operate in"
      description="Only these appear as load buttons, so the two that matter are not lost among 207."
      size="md"
    >
      <div className="space-y-4">
        <div className="space-y-1">
          {tracked.filter(t => t.is_active).map(t => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
              <span className="flex-1 text-sm text-slate-800 dark:text-slate-200">
                {t.country_name}
                {t.region_name && <span className="text-slate-400"> &middot; {t.region_name}</span>}
              </span>
              <Badge variant="neutral">{t.country_code}{t.region_code ? `-${t.region_code}` : ''}</Badge>
              <button
                onClick={() => remove.mutate(t.id)}
                className="text-xs text-slate-400 underline decoration-dotted hover:text-red-600 dark:hover:text-red-400"
              >
                Remove
              </button>
            </div>
          ))}
          {tracked.filter(t => t.is_active).length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">None yet.</p>
          )}
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Country</span>
            <select
              value={country}
              onChange={e => { setCountry(e.target.value); setRegion(''); }}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">Choose&hellip;</option>
              {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </label>

          {(regions?.length ?? 0) > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                State or region
              </span>
              <select
                value={region}
                onChange={e => setRegion(e.target.value)}
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">Whole country</option>
                {regions!.map(r => <option key={r.code} value={r.code}>{r.name}</option>)}
              </select>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                A region adds its own public holidays on top of the national ones.
              </span>
            </label>
          )}

          <Button disabled={!country} loading={add.isPending} onClick={() => add.mutate()}>
            Add country
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
