'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { cn } from '@/lib/cn';

/**
 * Whether to send prior turns for context.
 *
 * Follow-ups ("now do September") are much nicer with history on, and the
 * assistant is required to state the period it used in every answer — which is
 * what makes a mis-carried period visible rather than silent.
 */
const SEND_HISTORY = true;

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

const toolLabel = (n: string) => TOOL_LABELS[n] ?? 'Looking that up';

const SUGGESTIONS = [
  "Who's absent today?",
  'Late arrivals this month',
  'Summary for last month',
  'Compare departments',
  'Export last month to Excel',
  "Who's on leave this week?",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DownloadFile {
  download_url: string;
  filename: string;
  format: string;
  report_label: string;
  rows: number;
  period?: string;
}

interface Source {
  tool: string;
  rows: number | null;
  period?: string;
  error?: string;
}

interface ToolStatus {
  name: string;
  done: boolean;
  rows?: number | null;
  error?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  downloads?: DownloadFile[];
  failed?: boolean;
  at: number;
}

type StreamEvent =
  | { type: 'tool_start'; name: string }
  | { type: 'tool_done'; name: string; rows: number | null; period?: string; error?: string }
  | { type: 'download'; file: DownloadFile }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; traces: Array<{ name: string; rows: number | null; range_label?: string; error?: string }> }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Minimal markdown — tables, bold, bullets. Avoids a markdown dependency for
// the small, known subset that report answers actually use.
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

function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = splitRow(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
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
                    className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-200"
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
                  className="border-t border-slate-200/70 dark:border-slate-600/40"
                >
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      className="whitespace-nowrap px-2.5 py-1.5 text-slate-600 dark:text-slate-300"
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
// Pieces
// ---------------------------------------------------------------------------

function BotAvatar({ busy }: { busy?: boolean }) {
  return (
    <div
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-full',
        'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm',
        busy && 'chat-ring',
      )}
    >
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M5 12H3m18 0h-2M7.5 7.5 6 6m12 1.5L19.5 6M7.5 16.5 6 18m12-1.5L19.5 18" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="chat-dot h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-400"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

function ToolProgress({ tools }: { tools: ToolStatus[] }) {
  if (tools.length === 0) return null;
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
              <svg className="h-3 w-3 shrink-0 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8.5 3.5a1.7 1.7 0 0 1 3 0l5.4 9.6A1.7 1.7 0 0 1 15.4 16H4.6a1.7 1.7 0 0 1-1.5-2.9L8.5 3.5ZM10 7v4m0 2.5v.5" />
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
          <span className={cn('text-slate-600 dark:text-slate-300', t.done && 'text-slate-400 dark:text-slate-500')}>
            {toolLabel(t.name)}
            {t.done && t.rows != null && !t.error && (
              <span className="ml-1 text-slate-400 dark:text-slate-500">· {t.rows}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const FORMAT_STYLE: Record<string, string> = {
  xlsx: 'from-emerald-500 to-green-600',
  csv: 'from-slate-500 to-slate-600',
  pdf: 'from-rose-500 to-red-600',
};

function DownloadCard({ file }: { file: DownloadFile }) {
  return (
    <a
      href={file.download_url}
      download
      className={cn(
        'chat-pop group mt-2 flex items-center gap-2.5 rounded-xl border p-2.5 no-underline transition-all',
        'border-slate-200 bg-white hover:border-blue-400 hover:shadow-md',
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

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="mt-2 border-t border-slate-200/70 pt-1.5 dark:border-slate-600/50">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[10px] text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
      >
        <svg
          className={cn('h-2.5 w-2.5 transition-transform', open && 'rotate-90')}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
        {sources.length} source{sources.length === 1 ? '' : 's'}
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

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked — nothing useful to do */
        }
      }}
      aria-label="Copy answer"
      className="rounded p-1 text-slate-400 opacity-0 transition-all hover:bg-slate-200/60 hover:text-slate-600 focus:opacity-100 group-hover/msg:opacity-100 dark:hover:bg-slate-600/50"
    >
      {done ? (
        <svg className="h-3 w-3 text-emerald-500" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function ChatPanel() {
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // Live state for the in-flight answer.
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [streamText, setStreamText] = useState('');
  const [streamFiles, setStreamFiles] = useState<DownloadFile[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);

  const allowed = user?.role === 'super_admin';

  // Only auto-scroll when the user hasn't scrolled up to read something.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turns, streamText, tools, streamFiles, busy]);

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 120);
  }, [open]);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`;
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;

    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    atBottomRef.current = true;
    setTurns(t => [...t, { role: 'user', content: q, at: Date.now() }]);
    setBusy(true);
    setTools([]);
    setStreamText('');
    setStreamFiles([]);

    const history = SEND_HISTORY
      ? turns.filter(t => !t.failed).slice(-6).map(t => ({ role: t.role, content: t.content }))
      : [];

    const post = () =>
      fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });

    const fail = (message: string) => {
      setTurns(t => [...t, { role: 'assistant', content: message, failed: true, at: Date.now() }]);
    };

    try {
      let res = await post();

      // Mirror lib/api.ts: silently refresh an expired access token once.
      if (res.status === 401) {
        const refreshed = await fetch('/api/auth/refresh', { method: 'POST' })
          .then(r => r.ok)
          .catch(() => false);
        if (!refreshed) {
          window.location.href = '/login';
          return;
        }
        res = await post();
      }

      if (!res.ok || !res.body) {
        const msg = await res
          .json()
          .then((j: { error?: string }) => j.error)
          .catch(() => null);
        fail(msg ?? 'Could not reach the assistant.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      let sources: Source[] = [];
      const files: DownloadFile[] = [];
      let errored: string | null = null;

      // SSE frames are separated by a blank line; a frame can straddle chunks.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;

          let ev: StreamEvent;
          try {
            ev = JSON.parse(line.slice(6)) as StreamEvent;
          } catch {
            continue;
          }

          if (ev.type === 'tool_start') {
            setTools(prev => [...prev, { name: ev.name, done: false }]);
          } else if (ev.type === 'tool_done') {
            setTools(prev => {
              const idx = prev.findIndex(t => t.name === ev.name && !t.done);
              if (idx === -1) return [...prev, { name: ev.name, done: true, rows: ev.rows, error: ev.error }];
              const next = [...prev];
              next[idx] = { ...next[idx], done: true, rows: ev.rows, error: ev.error };
              return next;
            });
          } else if (ev.type === 'download') {
            files.push(ev.file);
            setStreamFiles([...files]);
          } else if (ev.type === 'delta') {
            answer += ev.text;
            setStreamText(answer);
          } else if (ev.type === 'done') {
            answer = ev.answer;
            sources = ev.traces.map(t => ({
              tool: t.name,
              rows: t.rows,
              period: t.range_label,
              error: t.error,
            }));
          } else if (ev.type === 'error') {
            errored = ev.message;
          }
        }
      }

      if (errored) {
        fail(errored);
      } else {
        setTurns(t => [
          ...t,
          {
            role: 'assistant',
            content: answer || 'No answer returned.',
            sources,
            downloads: files,
            at: Date.now(),
          },
        ]);
      }
    } catch {
      fail('The connection dropped before I finished. Please try again.');
    } finally {
      setBusy(false);
      setTools([]);
      setStreamText('');
      setStreamFiles([]);
    }
  }

  if (!allowed) return null;

  const firstName = user?.name?.split(' ')[0] ?? null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the reporting assistant"
          className={cn(
            'group fixed bottom-20 right-4 z-40 md:bottom-6 md:right-6',
            'flex h-12 items-center gap-2.5 rounded-full pl-3.5 pr-4',
            'bg-gradient-to-br from-blue-600 to-indigo-600 text-white',
            'shadow-lg shadow-blue-600/25 transition-all hover:shadow-xl hover:shadow-blue-600/35',
            'hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
          )}
        >
          <span className="relative grid h-6 w-6 place-items-center">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M5 12H3m18 0h-2M7.5 7.5 6 6m12 1.5L19.5 6M7.5 16.5 6 18m12-1.5L19.5 18" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-blue-600" />
          </span>
          <span className="text-sm font-semibold">Ask</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Reporting assistant"
          className={cn(
            'chat-pop fixed z-50 flex flex-col overflow-hidden bg-white dark:bg-slate-900',
            'inset-0 md:inset-auto md:bottom-6 md:right-6',
            'md:h-[min(43rem,calc(100vh-3rem))] md:w-[27rem] md:rounded-2xl',
            'shadow-2xl ring-1 ring-slate-200 dark:ring-slate-700',
          )}
        >
          {/* Header */}
          <header className="relative shrink-0 bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-white/15 backdrop-blur">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M5 12H3m18 0h-2M7.5 7.5 6 6m12 1.5L19.5 6M7.5 16.5 6 18m12-1.5L19.5 18" />
                    <circle cx="12" cy="12" r="3.5" />
                  </svg>
                </div>
                <span
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-blue-600',
                    busy ? 'bg-amber-300' : 'bg-emerald-400',
                  )}
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold leading-tight">Attendance Assistant</h2>
                <p className="flex items-center gap-1.5 text-[11px] text-blue-100">
                  {busy ? (
                    <>
                      <TypingDots />
                      <span>working on it…</span>
                    </>
                  ) : (
                    'Ready — asks only your own records'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
                {turns.length > 0 && !busy && (
                  <button
                    type="button"
                    onClick={() => setTurns([])}
                    className="rounded-lg px-2 py-1 text-[11px] text-blue-100 transition-colors hover:bg-white/15"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close assistant"
                  className="rounded-lg p-1.5 text-blue-100 transition-colors hover:bg-white/15"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </header>

          {/* Transcript */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="chat-scroll flex-1 space-y-3 overflow-y-auto bg-slate-50/60 px-3.5 py-4 dark:bg-slate-900"
          >
            {turns.length === 0 && !busy && (
              <div className="chat-rise pt-4 text-center">
                <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
                  <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M5 12H3m18 0h-2M7.5 7.5 6 6m12 1.5L19.5 6M7.5 16.5 6 18m12-1.5L19.5 18" />
                    <circle cx="12" cy="12" r="3.5" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {firstName ? `Hello ${firstName} 👋` : 'Hello 👋'}
                </p>
                <p className="mx-auto mt-1 max-w-[17rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Ask me anything about attendance, hours, leave or shifts. I can also put
                  it in an Excel, CSV or PDF file for you.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => ask(s)}
                      style={{ animationDelay: `${i * 45}ms` }}
                      className={cn(
                        'chat-rise rounded-full border bg-white px-2.5 py-1.5 text-[11px] font-medium transition-all',
                        'border-slate-200 text-slate-600 hover:-translate-y-0.5 hover:border-blue-400 hover:text-blue-600 hover:shadow-sm',
                        'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-blue-500 dark:hover:text-blue-400',
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="chat-rise flex justify-end">
                  <div className="max-w-[85%]">
                    <div className="rounded-2xl rounded-br-md bg-gradient-to-br from-blue-600 to-indigo-600 px-3.5 py-2 text-xs leading-relaxed text-white shadow-sm">
                      {t.content}
                    </div>
                    <p className="mt-1 pr-1 text-right text-[9.5px] text-slate-400">{clock(t.at)}</p>
                  </div>
                </div>
              ) : (
                <div key={i} className="chat-rise group/msg flex gap-2">
                  <BotAvatar />
                  <div className="min-w-0 max-w-[88%] flex-1">
                    <div
                      className={cn(
                        'rounded-2xl rounded-bl-md px-3.5 py-2.5 text-xs shadow-sm',
                        t.failed
                          ? 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900'
                          : 'bg-white text-slate-700 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
                      )}
                    >
                      <Markdownish text={t.content} />
                      {t.downloads?.map((f, fi) => <DownloadCard key={fi} file={f} />)}
                      {t.sources && <Sources sources={t.sources} />}
                    </div>
                    <div className="mt-1 flex items-center gap-1 pl-1">
                      <span className="text-[9.5px] text-slate-400">{clock(t.at)}</span>
                      {!t.failed && <CopyButton text={t.content} />}
                    </div>
                  </div>
                </div>
              ),
            )}

            {/* In-flight answer */}
            {busy && (
              <div className="chat-rise flex gap-2">
                <BotAvatar busy />
                <div className="min-w-0 max-w-[88%] flex-1">
                  <div className="rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-xs text-slate-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
                    <ToolProgress tools={tools} />
                    {streamText ? (
                      <>
                        <Markdownish text={streamText} />
                        <span className="chat-caret" />
                      </>
                    ) : (
                      tools.length === 0 && (
                        <span className="flex items-center gap-2 text-slate-400">
                          <TypingDots />
                          <span className="text-[11px]">thinking…</span>
                        </span>
                      )
                    )}
                    {streamFiles.map((f, fi) => <DownloadCard key={fi} file={f} />)}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={e => {
              e.preventDefault();
              ask(input);
            }}
            className="shrink-0 border-t border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900"
          >
            <div
              className={cn(
                'flex items-end gap-2 rounded-2xl border bg-slate-50 px-3 py-2 transition-all',
                'border-slate-200 focus-within:border-blue-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/20',
                'dark:border-slate-700 dark:bg-slate-800 dark:focus-within:border-blue-500 dark:focus-within:bg-slate-800',
              )}
            >
              <textarea
                ref={taRef}
                rows={1}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  grow();
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ask(input);
                  }
                }}
                placeholder={busy ? 'Working on your last question…' : 'Ask about attendance, leave or shifts…'}
                maxLength={1000}
                disabled={busy}
                className={cn(
                  'max-h-[110px] min-w-0 flex-1 resize-none bg-transparent text-xs leading-relaxed',
                  'text-slate-800 placeholder:text-slate-400 focus:outline-none',
                  'dark:text-slate-100 dark:placeholder:text-slate-500',
                  'disabled:opacity-60',
                )}
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send"
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full transition-all',
                  input.trim() && !busy
                    ? 'bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-sm hover:scale-105'
                    : 'bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500',
                )}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3.4 20.4l17.5-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 0 0 1.4 1.1Z" />
                </svg>
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[9.5px] text-slate-400 dark:text-slate-500">
              Reads your attendance records only — never invents figures.
            </p>
          </form>
        </div>
      )}
    </>
  );
}
