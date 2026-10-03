'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { DownloadFile, Source, ToolStatus } from './chatTypes';

/**
 * Presentational pieces of the reporting assistant.
 *
 * Kept apart from ChatPanel so the panel file is about interaction — streaming,
 * aborting, scrolling, persistence — and this file is about how a turn looks.
 */

// ---------------------------------------------------------------------------
// Tool vocabulary
// ---------------------------------------------------------------------------

/** Human phrasing for each tool, shown live while it runs. */
const TOOL_LABELS: Record<string, string> = {
  resolve_employee: 'Finding the employee',
  get_employee_profile: 'Reading their profile',
  list_departments: 'Checking departments',
  get_attendance_summary: 'Totalling attendance',
  get_attendance_detail: 'Reading day-by-day records',
  get_daily_snapshot: 'Checking that day',
  get_late_arrivals: 'Counting late arrivals',
  get_absentees: 'Counting absences',
  get_department_rollup: 'Comparing departments',
  get_geofence_exceptions: 'Checking geofence records',
  get_leave_records: 'Reading leave records',
  get_holidays: 'Checking the holiday calendar',
  get_leave_balance: 'Working out the leave balance',
  get_shifts: 'Reading shift setup',
  get_schedule: 'Reading shift assignments',
  get_live_tracking_status: 'Checking live tracking',
  get_audit_trail: 'Reading the audit trail',
  create_report_download: 'Building your file',
};

export const toolLabel = (n: string) => TOOL_LABELS[n] ?? 'Looking that up';

// ---------------------------------------------------------------------------
// Minimal markdown — tables, bold, bullets, headings. Avoids a markdown
// dependency for the small, known subset that report answers actually use.
// ---------------------------------------------------------------------------

function renderInline(text: string, k: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={`${k}-${i}`} className="font-semibold text-slate-900 dark:text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={`${k}-${i}`}
          className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[11px] dark:bg-slate-700/70"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${k}-${i}`}>{part}</span>;
  });
}

const isRow = (l: string) => l.trim().startsWith('|') && l.trim().endsWith('|');
const isDivider = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
const splitRow = (l: string) => l.trim().slice(1, -1).split('|').map(c => c.trim());

/** Numeric-looking cells read far better right-aligned in a dense table. */
const isNumericCell = (c: string) => /^[-+]?[\d,.]+\s*(%|h|hrs?|m|min|mins)?$/i.test(c.trim());

export function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table
    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = splitRow(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      // Align a column right when its data is numeric, judged from the body.
      const rightAligned = head.map((_, ci) => {
        const cells = body.map(r => r[ci] ?? '').filter(c => c !== '' && c !== '-');
        return cells.length > 0 && cells.every(isNumericCell);
      });
      out.push(
        <div
          key={`t${i}`}
          className="my-2 overflow-x-auto rounded-lg border border-slate-200/80 dark:border-slate-600/60"
        >
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-100/80 dark:bg-slate-700/50">
                {head.map((h, hi) => (
                  <th
                    key={hi}
                    className={cn(
                      'whitespace-nowrap px-2.5 py-1.5 font-semibold text-slate-700 dark:text-slate-200',
                      rightAligned[hi] ? 'text-right' : 'text-left',
                    )}
                  >
                    {renderInline(h, `h${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr
                  key={ri}
                  className="border-t border-slate-200/70 transition-colors hover:bg-blue-50/50 dark:border-slate-600/40 dark:hover:bg-slate-700/30"
                >
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        'whitespace-nowrap px-2.5 py-1.5 text-slate-600 dark:text-slate-300',
                        rightAligned[ci] && 'text-right font-medium tabular-nums',
                      )}
                    >
                      {renderInline(c, `c${ri}${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading — the model uses these to label a section of a longer answer.
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(
        <p
          key={`h${i}`}
          className="mb-1 mt-2.5 text-[11.5px] font-semibold uppercase tracking-wide text-slate-500 first:mt-0 dark:text-slate-400"
        >
          {renderInline(heading[2], `hh${i}`)}
        </p>,
      );
      i += 1;
      continue;
    }

    // Bullets
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      out.push(
        <ul key={`u${i}`} className="my-1.5 space-y-1 pl-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2">
              <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-blue-500/70" />
              <span>{renderInline(it, `li${ii}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      out.push(
        <ol key={`o${i}`} className="my-1.5 space-y-1 pl-1">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2">
              <span className="mt-[1px] w-3.5 shrink-0 text-right text-[10px] font-semibold text-blue-500/80">
                {ii + 1}.
              </span>
              <span>{renderInline(it, `oi${ii}`)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    out.push(
      <p key={`p${i}`} className="my-1.5 leading-[1.6]">
        {renderInline(line, `p${i}`)}
      </p>,
    );
    i += 1;
  }

  return <>{out}</>;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * The assistant glyph. A wrapper span carries the caller's sizing, colour and
 * padding; the svg fills the content box, so the same component works as a
 * bare 20px icon and as a padded 28px avatar.
 */
export function BotMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-grid place-items-center', className)}>
      <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v2m0 14v2M5 12H3m18 0h-2M7.5 7.5 6 6m12 1.5L19.5 6M7.5 16.5 6 18m12-1.5L19.5 18"
        />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </span>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="chat-dot h-1.5 w-1.5 rounded-full bg-current"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/**
 * Live tool progress. While work is in flight each step is listed; once every
 * step is done the list folds into one line, so a finished answer is not buried
 * under the scaffolding that produced it.
 */
export function ToolProgress({ tools }: { tools: ToolStatus[] }) {
  const [showAll, setShowAll] = useState(false);
  if (tools.length === 0) return null;

  const allDone = tools.every(t => t.done);
  const collapsed = allDone && !showAll && tools.length > 1;
  const errors = tools.filter(t => t.error).length;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setShowAll(true)}
        className="mb-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
      >
        <svg className="h-3 w-3 shrink-0 text-emerald-500" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
            clipRule="evenodd"
          />
        </svg>
        Checked {tools.length} records
        {errors > 0 ? ` · ${errors} had trouble` : ''}
        <span className="text-slate-300 dark:text-slate-600">· show steps</span>
      </button>
    );
  }

  return (
    <ul className="mb-1.5 space-y-1">
      {tools.map((t, i) => (
        <li
          key={`${t.name}-${i}`}
          className={cn(
            'chat-rise flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px]',
            !t.done && 'chat-shimmer',
          )}
        >
          {t.done ? (
            t.error ? (
              <svg
                className="h-3 w-3 shrink-0 text-amber-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 3.5v.5M10.3 4.3a2 2 0 0 1 3.4 0l7 12a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3l7-12Z"
                />
              </svg>
            ) : (
              <svg className="h-3 w-3 shrink-0 text-emerald-500" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                  clipRule="evenodd"
                />
              </svg>
            )
          ) : (
            <svg className="chat-spin h-3 w-3 shrink-0 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          <span
            className={cn(
              'min-w-0 text-slate-600 dark:text-slate-300',
              t.done && 'text-slate-400 dark:text-slate-500',
            )}
          >
            {toolLabel(t.name)}
            {t.done && t.period && (
              <span className="ml-1 text-slate-400 dark:text-slate-500">· {t.period}</span>
            )}
            {t.done && t.rows != null && !t.error && (
              <span className="ml-1 text-slate-400 dark:text-slate-500">· {t.rows} rows</span>
            )}
          </span>
        </li>
      ))}
      {allDone && tools.length > 1 && (
        <li>
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="px-1.5 text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            hide steps
          </button>
        </li>
      )}
    </ul>
  );
}

const FORMAT_STYLE: Record<string, string> = {
  xlsx: 'from-emerald-500 to-green-600',
  csv: 'from-slate-500 to-slate-600',
  pdf: 'from-rose-500 to-red-600',
};

export function DownloadCard({ file }: { file: DownloadFile }) {
  return (
    <a
      href={file.download_url}
      download
      className={cn(
        'chat-pop group mt-2 flex items-center gap-2.5 rounded-xl border p-2.5 no-underline transition-all',
        'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-md',
        'dark:border-slate-600 dark:bg-slate-800 dark:hover:border-blue-500',
      )}
    >
      <div
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-[9px] font-bold text-white',
          FORMAT_STYLE[file.format] ?? 'from-blue-500 to-indigo-600',
        )}
      >
        {file.format.toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold text-slate-800 dark:text-slate-100">
          {file.report_label}
        </p>
        <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
          {file.rows} row{file.rows === 1 ? '' : 's'}
          {file.period ? ` · ${file.period}` : ''}
          <span className="ml-1 text-slate-400 dark:text-slate-500">· link valid 15 min</span>
        </p>
      </div>
      <svg
        className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-y-0.5 group-hover:text-blue-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16" />
      </svg>
    </a>
  );
}

/** Where the answer came from. Collapsed by default; the claim comes first. */
export function SourceList({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="mt-2 border-t border-slate-200/70 pt-1.5 dark:border-slate-600/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[10px] text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
      >
        <svg
          className={cn('h-2.5 w-2.5 transition-transform', open && 'rotate-90')}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
        {sources.length} source{sources.length === 1 ? '' : 's'} from your records
      </button>
      {open && (
        <ul className="chat-rise mt-1 space-y-0.5">
          {sources.map((s, i) => (
            <li key={i} className="font-mono text-[9.5px] leading-relaxed text-slate-400 dark:text-slate-500">
              {s.tool}
              {s.period ? ` · ${s.period}` : ''}
              {s.rows != null ? ` · ${s.rows} rows` : ''}
              {s.error ? ` · ${s.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
