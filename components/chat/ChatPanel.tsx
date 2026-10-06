'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { cn } from '@/lib/cn';
import {
  BotMark,
  TypingDots,
  ToolProgress,
  DownloadCard,
  Markdownish,
  SourceList,
  toolLabel,
} from './ChatParts';
import type { ChatTurn, DownloadFile, Source, ToolStatus, LimitMeta } from './chatTypes';
import Chart from '@/components/charts/Chart';
import type { ChartSpec } from '@/lib/charts/types';

/**
 * Reporting assistant panel.
 *
 * Interaction decisions worth knowing, because each one is a deliberate answer
 * to a way chat UIs usually go wrong:
 *
 * - A Stop button exists for the whole time a reply is streaming, and stopping
 *   KEEPS the partial text with a "Stopped" marker rather than discarding it.
 * - Auto-scroll only follows the stream while the reader is already near the
 *   bottom. Scroll up and it locks, and a "Jump to latest" pill appears.
 * - Deltas are batched into one paint per frame instead of a React state update
 *   per token, so a long answer does not thrash the DOM.
 * - Errors say what went wrong and offer exactly one recovery action.
 * - The transcript survives closing the panel, via sessionStorage, because losing
 *   a conversation on close is its own small betrayal.
 * - Every answer carries the model that produced it and what it cost.
 */

const STORAGE_KEY = 'attendance_assistant_thread_v1';
const MAX_STORED_TURNS = 40;
/** Matches the signed download token's TTL in lib/chat/export.ts. */
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

/** Starter prompts, grouped so the real scope is legible at a glance. */
const SUGGESTION_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: 'Today', items: ["Who's absent today?", "Who's still clocked in?"] },
  { label: 'This month', items: ['Late arrivals this month', 'Attendance summary for last month'] },
  { label: 'Compare', items: ['Compare departments last month', 'Who has the most absences?'] },
  { label: 'Files', items: ['Export last month to Excel', 'Send me a PDF of last week'] },
];

/** Offered under a finished answer. Dismissible, and hidden once dismissed. */
function followUpsFor(sources: Source[] | undefined): string[] {
  const tools = new Set((sources ?? []).map(s => s.tool));
  if (tools.has('create_report_download')) return ['Show the same thing on screen', 'Do last month instead'];
  if (tools.has('get_daily_snapshot')) return ['Break that down by department', 'Send it as a file'];
  if (tools.has('get_attendance_summary')) return ['Export that to Excel', 'Just the late arrivals'];
  if (tools.has('get_late_arrivals') || tools.has('get_absentees')) return ['Show one person in detail', 'Export to Excel'];
  if (tools.has('resolve_employee')) return ['Show their last 30 days', 'Their leave balance'];
  return ['Export that to Excel', 'Narrow it to one department'];
}

/**
 * sessionStorage, deliberately, not localStorage.
 *
 * A thread holds real names against real absences. Keeping it for the tab's
 * lifetime covers what actually goes wrong — closing the panel, navigating to
 * another page, an accidental reload — without leaving HR data on disk for the
 * next person to use the machine.
 */
function loadThread(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as ChatTurn[]).slice(-MAX_STORED_TURNS).map(t =>
      // Download tokens last 15 minutes. Restoring a card whose link is already
      // dead just invites a click that fails, so drop it and keep the answer.
      t.downloads && Date.now() - t.at > DOWNLOAD_TTL_MS ? { ...t, downloads: undefined } : t,
    );
  } catch {
    // Private windows, cleared site data, blocked storage — all fine, start fresh.
    return [];
  }
}

function saveThread(turns: ChatTurn[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-MAX_STORED_TURNS)));
  } catch {
    /* storage unavailable or full — the panel still works, it just forgets */
  }
}

/** "2m ago" — cheaper to read at a glance than a clock time. */
function relative(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default function ChatPanel() {
  const user = useCurrentUser();
  const allowed = user?.role === 'super_admin';

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // In-flight answer state.
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [streamText, setStreamText] = useState('');
  const [streamFiles, setStreamFiles] = useState<DownloadFile[]>([]);
  const [streamCharts, setStreamCharts] = useState<ChartSpec[]>([]);
  const [limit, setLimit] = useState<LimitMeta | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dismissedFollowUps, setDismissedFollowUps] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Delta buffer + rAF handle: one paint per frame, not one per token.
  const bufRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  // Restore the transcript once, on first mount.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const stored = loadThread();
    if (stored.length) setTurns(stored);
  }, []);

  useEffect(() => {
    if (loadedRef.current) saveThread(turns);
  }, [turns]);

  // ---- scroll -------------------------------------------------------------
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setAtBottom(true);
  }, []);

  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [turns, streamText, tools, streamFiles, busy, atBottom, scrollToBottom]);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
        return;
      }
      if (e.key === 'Escape' && open) {
        if (busy) stop();
        else setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 120);
  }, [open]);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }

  // ---- streaming ----------------------------------------------------------
  function flushBuffer() {
    rafRef.current = null;
    if (!bufRef.current) return;
    const chunk = bufRef.current;
    bufRef.current = '';
    setStreamText(prev => prev + chunk);
  }

  function pushDelta(text: string) {
    bufRef.current += text;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(flushBuffer);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const finishedWith = useCallback(
    (turn: ChatTurn) => {
      setTurns(t => [...t, turn]);
      setTools([]);
      setStreamText('');
      setStreamFiles([]);
    setStreamCharts([]);
      setStreamCharts([]);
      bufRef.current = '';
      setDismissedFollowUps(false);
    },
    [],
  );

  async function ask(question: string, replacingLast = false) {
    const q = question.trim();
    if (!q || busy) return;

    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setAtBottom(true);
    setDismissedFollowUps(false);

    // On regenerate, drop the previous answer but keep the question.
    const base = replacingLast
      ? turns.slice(0, turns.findLastIndex(t => t.role === 'user') + 1)
      : [...turns, { role: 'user' as const, content: q, at: Date.now() }];
    setTurns(base);

    setBusy(true);
    setTools([]);
    setStreamText('');
    setStreamFiles([]);

    const history = base
      .filter(t => !t.failed && !t.stopped)
      .slice(-6)
      .map(t => ({ role: t.role, content: t.content }));

    const ac = new AbortController();
    abortRef.current = ac;

    let answer = '';
    let sources: Source[] = [];
    const files: DownloadFile[] = [];
    const charts: ChartSpec[] = [];
    let model = '';
    let usage: ChatTurn['usage'];
    let errored: string | null = null;

    const post = () =>
      fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history: history.slice(0, -1) }),
        signal: ac.signal,
      });

    try {
      let res = await post();

      if (res.status === 401) {
        const ok = await fetch('/api/auth/refresh', { method: 'POST' }).then(r => r.ok).catch(() => false);
        if (!ok) {
          window.location.href = '/login';
          return;
        }
        res = await post();
      }

      if (!res.ok || !res.body) {
        const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => null);
        finishedWith({
          role: 'assistant',
          content: msg ?? `The assistant returned HTTP ${res.status}.`,
          failed: true,
          retryOf: q,
          at: Date.now(),
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          switch (ev.type) {
            case 'meta':
              setLimit(ev.limit as LimitMeta);
              break;
            case 'tool_start':
              setTools(p => [...p, { name: String(ev.name), done: false }]);
              break;
            case 'tool_done':
              setTools(p => {
                const i = p.findIndex(t => t.name === ev.name && !t.done);
                const next = [...p];
                const patch = {
                  name: String(ev.name),
                  done: true,
                  rows: ev.rows as number | null,
                  period: ev.period as string | undefined,
                  error: ev.error as string | undefined,
                };
                if (i === -1) next.push(patch);
                else next[i] = patch;
                return next;
              });
              break;
            case 'download':
              files.push(ev.file as DownloadFile);
              setStreamFiles([...files]);
              break;
            case 'chart':
              charts.push(ev.chart as ChartSpec);
              setStreamCharts([...charts]);
              break;
            case 'delta':
              answer += String(ev.text);
              pushDelta(String(ev.text));
              break;
            case 'done':
              answer = String(ev.answer);
              model = String(ev.model ?? '');
              usage = ev.usage as ChatTurn['usage'];
              sources = ((ev.traces as Array<Record<string, unknown>>) ?? []).map(t => ({
                tool: String(t.name),
                rows: (t.rows as number | null) ?? null,
                period: t.range_label as string | undefined,
                error: t.error as string | undefined,
              }));
              break;
            case 'error':
              errored = String(ev.message);
              break;
          }
        }
      }

      if (errored) {
        finishedWith({ role: 'assistant', content: errored, failed: true, retryOf: q, at: Date.now() });
      } else {
        finishedWith({
          role: 'assistant',
          content: answer || 'No answer returned.',
          sources,
          downloads: files,
          charts,
          model,
          usage,
          at: Date.now(),
        });
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // Keep whatever arrived. Discarding it would waste the reader's time
        // and the tokens already spent.
        //
        // Read from `answer`, not the `streamText` state: this closure captured
        // streamText at the render that created this call, so it is always
        // stale here. `answer` accumulates every delta in scope.
        const partial = answer.trim();
        finishedWith({
          role: 'assistant',
          content: partial || '_(stopped before anything arrived)_',
          stopped: true,
          sources,
          downloads: files,
          charts,
          retryOf: q,
          at: Date.now(),
        });
      } else {
        finishedWith({
          role: 'assistant',
          content: 'The connection dropped before the answer finished.',
          failed: true,
          retryOf: q,
          at: Date.now(),
        });
      }
    } finally {
      // Drop any delta frame still waiting to paint — the turn is already
      // committed to the transcript, so painting it into the live bubble would
      // flash text that is about to be unmounted.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bufRef.current = '';
      abortRef.current = null;
      setBusy(false);
    }
  }

  function clearThread() {
    setTurns([]);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to do */
    }
  }

  const lastAssistant = useMemo(
    () => [...turns].reverse().find(t => t.role === 'assistant'),
    [turns],
  );
  const followUps = useMemo(
    () => (lastAssistant && !lastAssistant.failed && !busy && !dismissedFollowUps
      ? followUpsFor(lastAssistant.sources)
      : []),
    [lastAssistant, busy, dismissedFollowUps],
  );

  /**
   * One announcement per stage, for screen readers. Marking each bubble as a
   * live region instead would re-announce the whole restored transcript every
   * time the panel opens, and narrate the stream token by token.
   */
  const statusMessage = busy
    ? tools.length > 0 && !tools.every(t => t.done)
      ? `Reading your records — ${toolLabel(tools[tools.length - 1].name).toLowerCase()}`
      : streamText
        ? 'Writing the answer'
        : 'Working on it'
    : lastAssistant
      ? lastAssistant.failed
        ? 'That request did not go through'
        : lastAssistant.stopped
          ? 'Stopped'
          : 'Answer ready'
      : '';

  if (!allowed) return null;

  const firstName = user?.name?.split(' ')[0] ?? null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the reporting assistant (Ctrl+K)"
          title="Reporting assistant — Ctrl+K"
          className={cn(
            'group fixed bottom-20 right-4 z-40 md:bottom-6 md:right-6',
            'flex h-12 items-center gap-2.5 rounded-full pl-3.5 pr-4',
            'bg-gradient-to-br from-blue-600 to-indigo-600 text-white',
            'shadow-lg shadow-blue-600/25 transition-all hover:-translate-y-0.5 hover:shadow-xl',
            'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
          )}
        >
          <span className="relative grid h-6 w-6 place-items-center">
            <BotMark className="h-5 w-5" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-blue-600" />
          </span>
          <span className="text-sm font-semibold">Ask</span>
          <kbd className="ml-0.5 hidden rounded border border-white/30 px-1 text-[10px] font-medium text-blue-50 md:inline">
            ⌘K
          </kbd>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Reporting assistant"
          className={cn(
            'chat-pop fixed z-50 flex flex-col overflow-hidden bg-white dark:bg-slate-900',
            'shadow-2xl ring-1 ring-slate-200 dark:ring-slate-700',
            expanded
              ? 'inset-0 md:inset-6 md:rounded-2xl'
              : 'inset-0 md:inset-auto md:bottom-6 md:right-6 md:h-[min(44rem,calc(100vh-3rem))] md:w-[28rem] md:rounded-2xl',
          )}
        >
          {/* Header */}
          <header className="relative shrink-0 bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-white/15 backdrop-blur">
                  <BotMark className="h-5 w-5" />
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
                      <span>working…</span>
                    </>
                  ) : limit ? (
                    `${Math.max(0, limit.limit - limit.used)} of ${limit.limit} questions left this ${limit.windowMinutes}-min window`
                  ) : (
                    'Reads your attendance records only'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
                {turns.length > 0 && !busy && (
                  <button
                    type="button"
                    onClick={clearThread}
                    className="rounded-lg px-2 py-1 text-[11px] text-blue-100 transition-colors hover:bg-white/15"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(e => !e)}
                  aria-label={expanded ? 'Shrink panel' : 'Expand panel'}
                  title={expanded ? 'Shrink' : 'Expand — easier for wide tables'}
                  className="hidden rounded-lg p-1.5 text-blue-100 transition-colors hover:bg-white/15 md:block"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    {expanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9H4m0 0V4m0 5 6-6m5 16h5m0 0v-5m0 5-6-6" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l6 6m10-2V4m0 0h-4m4 0-6 6M4 16v4m0 0h4m-4 0 6-6m10 6v-4m0 4h-4m4 0-6-6" />
                    )}
                  </svg>
                </button>
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

          <p role="status" aria-live="polite" className="sr-only">
            {statusMessage}
          </p>

          {/* Transcript */}
          <div className="relative flex-1 overflow-hidden">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="chat-scroll h-full overflow-y-auto bg-slate-50/60 px-3.5 py-4 dark:bg-slate-900"
            >
              <div className={cn('mx-auto space-y-3', expanded && 'max-w-3xl')}>
                {turns.length === 0 && !busy && (
                  <div className="chat-rise pt-3 text-center">
                    <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/25">
                      <BotMark className="h-7 w-7 text-white" />
                    </div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {firstName ? `Hello ${firstName}` : 'Hello'}
                    </p>
                    <p className="mx-auto mt-1 max-w-[19rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      Ask about attendance, hours, leave or shifts. I read only this
                      app&apos;s records, and I can put any answer in a file.
                    </p>
                    <div className="mt-4 space-y-2.5 text-left">
                      {SUGGESTION_GROUPS.map(g => (
                        <div key={g.label}>
                          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                            {g.label}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {g.items.map(s => (
                              <button
                                key={s}
                                type="button"
                                onClick={() => ask(s)}
                                className={cn(
                                  'rounded-full border bg-white px-2.5 py-1.5 text-[11px] font-medium transition-all',
                                  'border-slate-200 text-slate-600 hover:-translate-y-0.5 hover:border-blue-400 hover:text-blue-600 hover:shadow-sm',
                                  'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-blue-500 dark:hover:text-blue-400',
                                )}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
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
                        <p className="mt-1 pr-1 text-right text-[9.5px] text-slate-400">{relative(t.at)}</p>
                      </div>
                    </div>
                  ) : (
                    <AssistantTurn
                      key={i}
                      turn={t}
                      onRetry={() => t.retryOf && ask(t.retryOf, true)}
                      onRegenerate={() => {
                        const lastQ = [...turns].reverse().find(x => x.role === 'user');
                        if (lastQ) ask(lastQ.content, true);
                      }}
                      isLast={i === turns.length - 1}
                      busy={busy}
                    />
                  ),
                )}

                {/* In-flight */}
                {busy && (
                  <div className="chat-rise flex gap-2">
                    <BotMark className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 p-1.5 text-white chat-ring" />
                    <div className="min-w-0 flex-1">
                      <div
                        aria-busy="true"
                        className="rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-xs text-slate-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
                      >
                        <ToolProgress tools={tools} />
                        {streamText ? (
                          <>
                            <Markdownish text={streamText} />
                            <span className="chat-caret" />
                          </>
                        ) : (
                          tools.length === 0 && (
                            <div className="space-y-1.5 py-0.5">
                              <div className="chat-skeleton-line w-3/4" />
                              <div className="chat-skeleton-line w-1/2" />
                            </div>
                          )
                        )}
                        {streamCharts.map((c, ci) => <Chart key={ci} spec={c} />)}
                        {streamFiles.map((f, fi) => <DownloadCard key={fi} file={f} />)}
                      </div>
                      <div className="mt-1.5 pl-1">
                        <button
                          type="button"
                          onClick={stop}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors',
                            'border-slate-300 bg-white text-slate-600 hover:border-red-400 hover:text-red-600',
                            'dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-red-500',
                          )}
                        >
                          <span className="h-2 w-2 rounded-sm bg-current" />
                          Stop
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Dismissible follow-ups */}
                {followUps.length > 0 && (
                  <div className="chat-fade-up flex flex-wrap items-center gap-1.5 pl-9">
                    {followUps.map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => ask(f)}
                        className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
                      >
                        {f}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setDismissedFollowUps(true)}
                      aria-label="Dismiss suggestions"
                      className="rounded px-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </div>

            {!atBottom && (
              <button
                type="button"
                onClick={() => scrollToBottom()}
                className="chat-jump absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-slate-900/85 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg backdrop-blur hover:bg-slate-900 dark:bg-slate-100/90 dark:text-slate-900"
              >
                Jump to latest ↓
              </button>
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
            <div className={cn('mx-auto', expanded && 'max-w-3xl')}>
              <div
                className={cn(
                  'flex items-end gap-2 rounded-2xl border bg-slate-50 px-3 py-2 transition-all',
                  'border-slate-200 focus-within:border-blue-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/20',
                  'dark:border-slate-700 dark:bg-slate-800 dark:focus-within:border-blue-500',
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
                    'max-h-32 min-w-0 flex-1 resize-none bg-transparent text-xs leading-relaxed',
                    'text-slate-800 placeholder:text-slate-400 focus:outline-none',
                    'dark:text-slate-100 dark:placeholder:text-slate-500 disabled:opacity-60',
                  )}
                />
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    aria-label="Stop generating"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-red-500 text-white transition-transform hover:scale-105"
                  >
                    <span className="h-2.5 w-2.5 rounded-sm bg-white" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    aria-label="Send"
                    className={cn(
                      'grid h-7 w-7 shrink-0 place-items-center rounded-full transition-all',
                      input.trim()
                        ? 'bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-sm hover:scale-105'
                        : 'bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500',
                    )}
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3.4 20.4l17.5-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 0 0 1.4 1.1Z" />
                    </svg>
                  </button>
                )}
              </div>
              <p className="mt-1.5 flex items-center justify-between px-1 text-[9.5px] text-slate-400 dark:text-slate-500">
                <span>Reads your attendance records only — never invents figures.</span>
                <span className="hidden md:inline">Enter to send · Shift+Enter newline · Esc to close</span>
              </p>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

/** One assistant turn, with its actions, provenance and cost. */
function AssistantTurn({
  turn,
  onRetry,
  onRegenerate,
  isLast,
  busy,
}: {
  turn: ChatTurn;
  onRetry: () => void;
  onRegenerate: () => void;
  isLast: boolean;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — nothing useful to do */
    }
  }

  const tone = turn.failed
    ? 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900'
    : turn.stopped
      ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/60'
      : 'bg-white text-slate-700 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700';

  return (
    <div className="chat-rise group/msg flex gap-2">
      <BotMark className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 p-1.5 text-white" />
      <div className="min-w-0 flex-1">
        <div className={cn('rounded-2xl rounded-bl-md px-3.5 py-2.5 text-xs shadow-sm', tone)}>
          {turn.stopped && (
            <p className="mb-1.5 inline-flex items-center gap-1 rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
              Stopped
            </p>
          )}
          <Markdownish text={turn.content} />
          {turn.charts?.map((c, i) => <Chart key={i} spec={c} />)}
          {turn.downloads?.map((f, i) => <DownloadCard key={i} file={f} />)}
          {turn.sources && turn.sources.length > 0 && <SourceList sources={turn.sources} />}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1 pl-1">
          <span className="text-[9.5px] text-slate-400">{relative(turn.at)}</span>

          {turn.model && (
            <span
              title={
                turn.usage
                  ? `${turn.usage.prompt_tokens.toLocaleString()} in / ${turn.usage.completion_tokens.toLocaleString()} out tokens`
                  : undefined
              }
              className="rounded bg-slate-100 px-1 text-[9.5px] font-medium text-slate-500 dark:bg-slate-700/60 dark:text-slate-400"
            >
              {turn.model}
              {turn.usage ? ` · ${(turn.usage.prompt_tokens + turn.usage.completion_tokens).toLocaleString()} tok` : ''}
            </span>
          )}

          {!turn.failed && (
            <button
              type="button"
              onClick={copy}
              aria-label="Copy answer"
              className="rounded p-1 text-slate-400 opacity-0 transition-all hover:bg-slate-200/60 hover:text-slate-600 focus:opacity-100 group-hover/msg:opacity-100 dark:hover:bg-slate-600/50"
            >
              {copied ? (
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
          )}

          {/* One clear recovery action, never a bare "something went wrong". */}
          {(turn.failed || turn.stopped) && turn.retryOf && !busy && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-slate-600 dark:text-slate-300"
            >
              {turn.stopped ? 'Ask again' : 'Try again'}
            </button>
          )}

          {!turn.failed && !turn.stopped && isLast && !busy && (
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-400 opacity-0 transition-all hover:text-slate-600 group-hover/msg:opacity-100 dark:hover:text-slate-200"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
