'use client';

/**
 * components/ui/FilterBar.tsx — one filter pattern, everywhere.
 *
 * Filters were present on some pages, absent on others, and in a different
 * place on each of the ones that had them. That inconsistency is most of what
 * made them feel missing: a control somebody has to look for is a control they
 * stop expecting.
 *
 * Two things this does that a row of inputs does not:
 *
 *   It SAYS WHAT IS APPLIED. A filtered list that looks like an unfiltered one
 *   is how somebody concludes a record has been deleted. Active filters appear
 *   as chips with the value in them, each removable on its own.
 *
 *   It SAYS WHAT IT IS SHOWING. "12 of 48" is the difference between "the
 *   filter is working" and "where did everybody go".
 *
 * Search is debounced here rather than in each caller, because every page that
 * forgot to do it filtered on every keystroke against the full list.
 */

import { useEffect, useState, type ReactNode } from 'react';

export interface FilterOption { value: string; label: string }

export interface FilterDef {
  key: string;
  label: string;
  options: FilterOption[];
  /** Shown when nothing is chosen. Defaults to "All <label>". */
  allLabel?: string;
}

export interface FilterBarProps {
  search?: string;
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
  filters?: FilterDef[];
  values?: Record<string, string>;
  onChange?: (key: string, value: string) => void;
  onClear?: () => void;
  /** Shown on the right: "12 of 48". Both numbers, or neither. */
  showing?: { shown: number; total: number; noun?: string };
  /** Anything page-specific — an export button, a date range. */
  children?: ReactNode;
}

export default function FilterBar({
  search, onSearchChange, searchPlaceholder = 'Search…',
  filters = [], values = {}, onChange, onClear, showing, children,
}: FilterBarProps) {
  // Typed text is held locally and pushed up after a pause, so a page filtering
  // a long list does it once rather than on every keystroke.
  const [typed, setTyped] = useState(search ?? '');
  // The last value handed upwards. Held as state rather than a ref so the
  // comparison below can happen while rendering: a parent that clears the
  // search should show an empty box in the SAME render, not one frame later.
  const [pushed, setPushed] = useState(search ?? '');

  // Adjusting state during render, which React supports and prescribes for
  // exactly this - a controlled value changing underneath a local draft.
  // Guarded on inequality, so it settles after one extra render pass.
  if (search !== undefined && search !== pushed) {
    setPushed(search);
    setTyped(search);
  }

  useEffect(() => {
    if (!onSearchChange) return;
    if (typed === pushed) return;
    const id = setTimeout(() => {
      setPushed(typed);
      onSearchChange(typed);
    }, 250);
    return () => clearTimeout(id);
  }, [typed, pushed, onSearchChange]);

  const active = filters
    .map(f => ({ f, value: values[f.key] }))
    .filter(x => x.value !== undefined && x.value !== '');

  const hasAny = active.length > 0 || (typed?.trim().length ?? 0) > 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        {onSearchChange && (
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 sm:max-w-xs">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Search
            </span>
            <input
              type="search"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
        )}

        {filters.map(f => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {f.label}
            </span>
            <select
              value={values[f.key] ?? ''}
              onChange={e => onChange?.(f.key, e.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              <option value="">{f.allLabel ?? `All ${f.label.toLowerCase()}`}</option>
              {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ))}

        {children}

        {showing && (
          <div className="ml-auto pb-1 text-right">
            <p className="text-sm font-medium tabular-nums text-slate-800 dark:text-slate-200">
              {showing.shown === showing.total
                ? `${showing.total}`
                : `${showing.shown} of ${showing.total}`}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {showing.noun ?? 'results'}
            </p>
          </div>
        )}
      </div>

      {/* What is actually applied. A filtered list that looks unfiltered is how
          somebody concludes a record has been deleted. */}
      {hasAny && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          <span className="text-xs text-slate-500 dark:text-slate-400">Showing only:</span>
          {typed.trim() && (
            <Chip label={`matching "${typed.trim()}"`} onRemove={() => { setTyped(''); }} />
          )}
          {active.map(({ f, value }) => (
            <Chip
              key={f.key}
              label={`${f.label}: ${f.options.find(o => o.value === value)?.label ?? value}`}
              onRemove={() => onChange?.(f.key, '')}
            />
          ))}
          {onClear && (
            <button
              onClick={() => { setTyped(''); onClear(); }}
              className="ml-1 text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      onClick={onRemove}
      className="group flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-red-50 hover:text-red-700 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-red-950/40 dark:hover:text-red-300"
      title="Remove this filter"
    >
      {label}
      <span aria-hidden="true" className="opacity-50 group-hover:opacity-100">&times;</span>
    </button>
  );
}
