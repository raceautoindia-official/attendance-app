'use client';

/**
 * Ctrl/Cmd-K — type three letters, go there.
 *
 * WHY IT IS PART OF THE NAVIGATION CHANGE, NOT A FLOURISH
 * -------------------------------------------------------
 * Grouping eighteen pages into six sections puts most of them one level deeper
 * than they were. That is the right trade for a rail somebody can read, but it
 * has to be paid for: this is the payment. Anything in the app is two
 * keystrokes away regardless of which section it lives in.
 *
 * It also reaches PEOPLE, which the old menu search could not. "RACE014" and
 * "arun" are how an administrator actually thinks about where they want to go,
 * and the answer - that person's hours - was four clicks from here.
 *
 * Keyboard-only by design, with the mouse working anyway. No fuzzy matching:
 * substring is predictable, and a palette that reorders itself cleverly while
 * you type is one you stop trusting to be on the row you are about to press
 * Enter on.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { useNavAccess } from '@/lib/useNavAccess';
import { allVisibleItems } from '@/lib/nav';
import type { ApiResponse, Employee } from '@/lib/types';

interface Hit {
  key: string;
  label: string;
  hint: string;
  group: string;
  href: string;
}

/**
 * Mounted only while open, which is what keeps it free of effects: the
 * empty query and the cursor at the top are simply its initial state, and
 * autoFocus does what a focus effect would. Clearing itself on open through
 * an effect instead meant setting state during a render pass for no gain.
 */
export default function CommandPalette({ onOpenChange }: {
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const access = useNavAccess();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const q = query.trim().toLowerCase();

  const pages: Hit[] = useMemo(
    () => allVisibleItems(access)
      .filter(i => !q
        || i.label.toLowerCase().includes(q)
        || i.section.toLowerCase().includes(q)
        || (i.hint ?? '').toLowerCase().includes(q))
      .map(i => ({
        key: `page:${i.href}`,
        label: i.label,
        hint: i.hint ?? '',
        group: i.section,
        href: i.href,
      })),
    [access, q],
  );

  // People are only looked up once there is something to look up: one or two
  // letters match most of the company and the list would be noise.
  const { data: peopleData } = useQuery({
    queryKey: ['palette', 'employees', q],
    queryFn: async () => {
      const res = await fetch(`/api/employees?search=${encodeURIComponent(q)}&limit=6`);
      return res.json() as Promise<ApiResponse<{ employees: Employee[] }>>;
    },
    enabled: q.length >= 2,
    staleTime: 60_000,
  });

  const people: Hit[] = (peopleData?.data?.employees ?? []).map(e => ({
    key: `employee:${e.id}`,
    label: e.name,
    hint: `${e.emp_id}${e.department ? ` - ${e.department}` : ''} - open their hours`,
    group: 'People',
    // The reports page already accepts ?employee=, so this lands on the thing
    // somebody searching for a person almost always wants.
    href: `/reports?employee=${e.id}`,
  }));

  const hits = [...pages, ...people];
  const safeCursor = Math.min(cursor, Math.max(0, hits.length - 1));

  function go(hit: Hit | undefined) {
    if (!hit) return;
    onOpenChange(false);
    router.push(hit.href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onOpenChange(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => (hits.length === 0 ? 0 : (c + 1) % hits.length));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => (hits.length === 0 ? 0 : (c - 1 + hits.length) % hits.length));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[safeCursor]);
    }
  }


  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 dark:border-slate-700">
          <svg className="h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, or find a person…"
            className="h-12 flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none dark:text-slate-100"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-300 px-1.5 text-[10px] text-slate-500 dark:border-slate-600 sm:block">
            Esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto py-1">
          {hits.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          )}
          {hits.map((hit, index) => (
            <button
              key={hit.key}
              type="button"
              onClick={() => go(hit)}
              onMouseEnter={() => setCursor(index)}
              className={cn(
                'flex w-full items-baseline gap-3 px-4 py-2 text-left',
                index === safeCursor
                  ? 'bg-blue-50 dark:bg-blue-900/30'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-700/40',
              )}
            >
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{hit.label}</span>
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">{hit.hint}</span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                {hit.group}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400 dark:border-slate-700">
          <span>&uarr;&darr; to move</span>
          <span>Enter to open</span>
          <span className="ml-auto">Ctrl K from anywhere</span>
        </div>
      </div>
    </div>
  );
}
