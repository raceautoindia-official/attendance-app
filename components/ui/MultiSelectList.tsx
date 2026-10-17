'use client';

/**
 * A list of things you tick.
 *
 * WHY NOT A <select multiple>
 * ---------------------------
 * Because nobody can use one. Ctrl-clicking to add a second item and
 * discovering that a plain click wiped the first is the single most reliably
 * misunderstood control on the web, and this app is used by people assigning
 * six work sites to a company once a year, not by power users.
 *
 * Checkboxes, a search box once the list is long enough to need one, and a
 * count of what is ticked. It also SHOWS what belongs to somebody else rather
 * than hiding it, because "why is that site not in the list" is otherwise
 * unanswerable from this screen.
 */

import { useState } from 'react';

export interface MultiSelectOption {
  id: number;
  label: string;
  /** Shown under the label - a city, a code, a parent department. */
  hint?: string | null;
  /** Non-null when it currently belongs to somebody else. */
  takenBy?: string | null;
}

export default function MultiSelectList({
  options, selected, onChange, emptyMessage, searchFrom = 8, disabled,
}: {
  options: MultiSelectOption[];
  selected: number[];
  onChange: (ids: number[]) => void;
  emptyMessage: string;
  /** Show the search box once there are at least this many options. */
  searchFrom?: number;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter(o =>
      o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q))
    : options;

  const toggle = (id: number) => {
    if (disabled) return;
    onChange(selected.includes(id)
      ? selected.filter(x => x !== id)
      : [...selected, id]);
  };

  if (options.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {options.length >= searchFrom && (
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search…"
          className="h-9 w-full rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
        {shown.map(option => {
          const isSelected = selected.includes(option.id);
          return (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggle(option.id)}
                disabled={disabled}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-800 dark:text-slate-200">
                  {option.label}
                </span>
                {(option.hint || option.takenBy) && (
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {option.hint}
                    {option.hint && option.takenBy ? ' · ' : ''}
                    {/* Said out loud rather than filtered away: ticking it moves
                        it, and somebody should know that before they do. */}
                    {option.takenBy && (
                      <span className="text-amber-600 dark:text-amber-400">
                        currently {option.takenBy}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {shown.length === 0 && (
          <p className="px-3 py-4 text-center text-sm text-slate-500 dark:text-slate-400">
            Nothing matches &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{selected.length} of {options.length} selected</span>
        {selected.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
