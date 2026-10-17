'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { ApiResponse } from '@/lib/types';
import type { SetupState, SetupStep, TourStop } from '@/lib/setup';
import { dialogIsOpen, subscribeDialog } from '@/lib/dialogOpen';

/**
 * The guided setup: a spotlight that walks an administrator through a workspace
 * that does not work yet, in the order it has to be built.
 *
 * WHAT MAKES THIS A FLOW AND NOT A TOUR
 * -------------------------------------
 * Three things, and all three are load-bearing:
 *
 *  1. IT NAVIGATES. Each step knows which page it happens on. If you are not
 *     there, the guide takes you there and then waits for the control to exist
 *     — because a page that has just been pushed has not rendered yet, and a
 *     tour that measures an element before it exists points at the corner of
 *     the screen.
 *
 *  2. YOU DO THE REAL THING. The spotlight is a hole, not a picture: the
 *     overlay has `pointer-events: none` everywhere except its own card, so
 *     the highlighted button is the actual button and clicking it opens the
 *     actual form. Nothing is simulated, so nothing can be "completed" without
 *     having happened.
 *
 *  3. IT WATCHES THE DATA, NOT THE CLICKS. While a step is open the guide
 *     re-asks the server every few seconds whether the thing exists yet. When
 *     the company is really saved, the step ticks and it moves on by itself.
 *     That is also what makes it resumable: close the browser half way, come
 *     back tomorrow on another machine, and it carries on from the first thing
 *     that is still missing.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not trap anybody. The overlay never blocks a click, Escape closes
 * it, and "Skip for now" stops the automatic opening without hiding the
 * button. An administrator who knows exactly what they are doing can ignore it
 * entirely and nothing nags again once the required steps are really done.
 */

const DISMISS_KEY = 'setup-guide-dismissed';

/**
 * TWO MODES, BECAUSE THERE ARE TWO DIFFERENT PEOPLE
 * -------------------------------------------------
 * `setup` is for whoever is building the workspace: it opens at the first
 * thing missing, and each step ticks itself off and advances when the thing
 * is really created.
 *
 * `tour` is for somebody who has just been given a login to a company that
 * has been running for years. Nothing is missing, so the setup list is six
 * green ticks and tells them nothing. The tour walks the PLACES instead -
 * what each section is for and where the day's work happens - and never
 * advances by itself, because there is nothing to wait for.
 *
 * The second one is why there is a menu rather than a single button. A
 * finished workspace used to say 'Setup complete' and offer no way back in,
 * which is exactly the person this is for.
 */
type Mode = 'setup' | 'tour';

/** A step and a stop, reduced to what the card needs to show. */
interface Showing {
  key: string;
  title: string;
  body: string;
  action: string | null;
  href: string;
  anchor: string | null;
  done: boolean;
  optional: boolean;
  count: number;
}

const fromStep = (s: SetupStep): Showing => ({
  key: s.key, title: s.title, body: s.why, action: s.action,
  href: s.href, anchor: s.anchor, done: s.done, optional: !s.required,
  count: s.count,
});

const fromStop = (t: TourStop): Showing => ({
  key: t.key, title: t.title, body: t.what, action: null,
  href: t.href, anchor: t.anchor, done: false, optional: false, count: 0,
});

/** How long to wait for a control to appear after a navigation, in ms. */
const ANCHOR_TIMEOUT = 5000;

interface Rect { top: number; left: number; width: number; height: number }

/**
 * Finds the step's control, waiting for it rather than assuming it is there.
 *
 * Returns null when it never appears, which is a normal outcome: the page may
 * have been redesigned, or the control may be behind a tab the person closed.
 * The card then explains the step in words instead of pointing at nothing.
 */
function useAnchorRect(anchor: string | null, pathname: string, active: boolean) {
  // Stored WITH the anchor it was measured for, so a stale rectangle from
  // the previous step is never shown against the next one - and so nothing
  // has to be cleared synchronously when the step changes.
  const [found, setFound] = useState<{ anchor: string; rect: Rect } | null>(null);
  const [searchingFor, setSearchingFor] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !anchor) return;

    let cancelled = false;
    let raf = 0;
    const started = Date.now();

    const measure = (el: Element) => {
      const r = el.getBoundingClientRect();
      // A control inside a collapsed section has no size. Treat it as not
      // found yet rather than highlighting a zero-pixel hole.
      if (r.width < 2 || r.height < 2) return false;
      setFound({ anchor, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
      return true;
    };

    const look = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${anchor}"]`);
      if (el && measure(el)) {
        setSearchingFor(null);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (Date.now() - started > ANCHOR_TIMEOUT) {
        setSearchingFor(null);
        return;
      }
      raf = window.setTimeout(look, 120);
    };
    // Scheduled rather than called: the search sets state, and an effect
    // body that sets state synchronously makes React render twice for every
    // step. The first tick is what marks it as searching.
    setTimeout(() => { if (!cancelled) { setSearchingFor(anchor); look(); } }, 0);

    return () => { cancelled = true; window.clearTimeout(raf); };
  }, [anchor, pathname, active]);

  // Keep the hole on the control while the page moves under it.
  useEffect(() => {
    if (!active || !anchor) return;
    const track = () => {
      const el = document.querySelector(`[data-tour="${anchor}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      setFound({ anchor, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
    };
    window.addEventListener('scroll', track, true);
    window.addEventListener('resize', track);
    return () => {
      window.removeEventListener('scroll', track, true);
      window.removeEventListener('resize', track);
    };
  }, [anchor, active]);

  return {
    rect: active && anchor && found?.anchor === anchor ? found.rect : null,
    searching: searchingFor !== null && searchingFor === anchor,
  };
}

export default function SetupGuide() {
  const router = useRouter();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('setup');
  const [menuOpen, setMenuOpen] = useState(false);
  const [index, setIndex] = useState(0);
  /** Set once the user has been sent to a step's page, so it happens once. */
  const navigatedFor = useRef<string | null>(null);
  /** The guide offers itself once per load, not once per poll. */
  const [offered, setOffered] = useState(false);
  /**
   * Steps that were still undone when they were shown. Only those advance by
   * themselves - otherwise stepping BACK to something finished would bounce
   * straight forward again, which reads as the guide fighting the person.
   */
  const seenUndone = useRef<Set<string>>(new Set());

  const { data } = useQuery<SetupState | null>({
    queryKey: ['setup'],
    queryFn: async () => {
      const res = await fetch('/api/setup');
      const json: ApiResponse<SetupState> = await res.json();
      // A manager without the permissions simply gets no guide. That is not an
      // error worth showing anybody.
      return json.success ? (json.data ?? null) : null;
    },
    retry: false,
    // While the guide is open, this is how a step ticks itself off: the thing
    // was created in the real form, and the next poll sees it.
    refetchInterval: open ? 2500 : false,
    refetchOnWindowFocus: true,
  });

  const setupSteps = useMemo(() => data?.steps ?? [], [data]);
  const tourStops = useMemo(() => data?.tour ?? [], [data]);

  // The tour ends with the setup list, so somebody taking it still learns
  // where the things they may one day have to create are made - but after
  // the places they will use every day, not before them.
  const steps: Showing[] = useMemo(() => (
    mode === 'tour'
      ? [...tourStops.map(fromStop), ...setupSteps.map(fromStep)]
      : setupSteps.map(fromStep)
  ), [mode, tourStops, setupSteps]);

  const step: Showing | undefined = steps[index];

  // Open by itself only for a workspace that has not been started, and only
  // once per browser until it is dismissed or finished. Decided during
  // render, which React supports for exactly this - an effect would mean a
  // second render of every page under the overlay.
  if (!offered && data && !open && data.isNewWorkspace && data.remaining.length > 0) {
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(DISMISS_KEY) === '1'; }
    catch { /* private window: offer it, it is only a nudge */ }
    setOffered(true);
    if (!dismissed) {
      const first = setupSteps.findIndex(s => !s.done);
      setMode('setup');
      setIndex(first < 0 ? 0 : first);
      setOpen(true);
    }
  }

  // Take them to the page the step happens on, once per step.
  useEffect(() => {
    if (!open || !step) return;
    if (navigatedFor.current === step.key) return;
    navigatedFor.current = step.key;
    const [path] = step.href.split('?');
    if (path !== pathname) router.push(step.href);
    else if (step.href.includes('?')) router.replace(step.href);
  }, [open, step, pathname, router]);

  // The step ticks itself off: the thing was created in the real form, the
  // next poll sees it, and the guide moves on. Nothing here watches clicks.
  useEffect(() => {
    if (!open || !step || mode === 'tour') return;
    if (!step.done) { seenUndone.current.add(step.key); return; }
    if (!seenUndone.current.has(step.key)) return;
    const next = steps.findIndex((s, i) => i > index && !s.done);
    const t = window.setTimeout(() => {
      if (next >= 0) { setIndex(next); navigatedFor.current = null; }
      else setOpen(false);
    }, 1400);
    return () => window.clearTimeout(t);
  }, [open, step, steps, index, mode]);

  const close = useCallback((remember: boolean) => {
    setOpen(false);
    navigatedFor.current = null;
    if (remember) {
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private window */ }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // A drawer or modal is open: the person is filling in the form the guide
  // just sent them to. Dimming it from above z-50 would put the fields behind
  // the overlay with the card floating over them, so the guide stands down
  // until the dialog closes - by which time the step has usually ticked.
  const dialogUp = useSyncExternalStore(subscribeDialog, dialogIsOpen, () => false);

  const { rect, searching } = useAnchorRect(
    step?.anchor ?? null, pathname, open && !dialogUp);

  if (!data) return null;

  const remaining = data.remaining.length;
  // 'Setup complete' read as a status, so nobody pressed it - and the person
  // who needed it most was the one for whom it was already complete. 'Guide'
  // reads as a thing you can open, which is what it is.
  const label = remaining === 0
    ? 'Guide'
    : `Setup ${data.requiredDone}/${data.requiredTotal}`;

  const go = (i: number) => {
    setIndex(i);
    navigatedFor.current = null;
  };

  /** Start one of the two walks, from the top or from the first gap. */
  const start = (m: Mode) => {
    setMenuOpen(false);
    setMode(m);
    seenUndone.current.clear();
    navigatedFor.current = null;
    // The tour always begins at the beginning - that is what makes it a
    // tour. The setup resumes where the work actually stopped.
    setIndex(m === 'tour' ? 0 : Math.max(0, setupSteps.findIndex(x => !x.done)));
    setOpen(true);
  };

  return (
    <>
      {/* The way back in. A plain button reading 'Setup complete' was a dead
          end for the one person who most needs this: somebody handed a login
          to a company that was set up years ago, for whom nothing is missing
          and nothing is familiar either. */}
      <div className="relative">
        <button
          type="button"
          data-tour="setup-button"
          onClick={() => setMenuOpen(o => !o)}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            remaining > 0
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700'
          }`}
          title="Guided setup, and a tour of what each part is for"
        >
          <span aria-hidden>{remaining > 0 ? '●' : '✓'}</span>
          <span className="hidden sm:inline">{label}</span>
          <span aria-hidden className="text-[10px] opacity-70">▾</span>
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-[62]" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full z-[63] mt-1 w-64 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800">
              {remaining > 0 && (
                <MenuItem
                  title="Carry on setting up"
                  note={`${remaining} ${remaining === 1 ? 'thing' : 'things'} left · ${data.requiredDone}/${data.requiredTotal} done`}
                  onClick={() => start('setup')}
                />
              )}
              <MenuItem
                title="Take the tour from the start"
                note="What each part of the app is for, one screen at a time. Begins at the beginning, however much is already set up."
                onClick={() => start('tour')}
              />
              {remaining === 0 && (
                <MenuItem
                  title="Walk the setup again"
                  note="Everything is done — this shows what was set up, and where each piece is changed."
                  onClick={() => start('setup')}
                />
              )}
            </div>
          </>
        )}
      </div>

      {open && step && !dialogUp && (
        <>
          {/* The dim, with a hole over the control. pointer-events: none so the
              real button underneath stays the real button - the person does the
              actual thing, which is the only reason the step can be trusted to
              tick itself. */}
          <div className="pointer-events-none fixed inset-0 z-[60]">
            {rect ? (
              <div
                className="absolute rounded-lg ring-4 ring-blue-500/70 transition-all duration-200"
                style={{
                  top: rect.top - 6,
                  left: rect.left - 6,
                  width: rect.width + 12,
                  height: rect.height + 12,
                  boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)',
                }}
              />
            ) : (
              <div className="absolute inset-0 bg-slate-900/40" />
            )}
          </div>

          <Card
            mode={mode}
            step={step}
            index={index}
            steps={steps}
            rect={rect}
            searching={searching}
            justDone={step.done}
            onGo={go}
            onClose={close}
            onRestart={() => start(mode)}
          />
        </>
      )}
    </>
  );
}

/** One choice in the guide menu: what it does, and why you would. */
function MenuItem({ title, note, onClick }: {
  title: string; note: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60"
    >
      <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </span>
      <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">
        {note}
      </span>
    </button>
  );
}

/**
 * The card. Positioned under the control when there is room, over it when
 * there is not, and in the middle of the screen when there is nothing to point
 * at - never off the edge, which is where a naive "below the rect" ends up for
 * anything in the lower half of the page.
 */
function Card({
  mode, step, index, steps, rect, searching, justDone, onGo, onClose, onRestart,
}: {
  mode: Mode;
  step: Showing;
  index: number;
  steps: Showing[];
  rect: Rect | null;
  searching: boolean;
  justDone: boolean;
  onGo: (i: number) => void;
  onClose: (remember: boolean) => void;
  onRestart: () => void;
}) {
  const WIDTH = 340;
  const style: React.CSSProperties = rect
    ? (() => {
      const below = rect.top + rect.height + 16;
      const fitsBelow = below + 260 < window.innerHeight;
      return {
        width: WIDTH,
        top: fitsBelow ? below : Math.max(12, rect.top - 272),
        left: Math.min(
          Math.max(12, rect.left + rect.width / 2 - WIDTH / 2),
          window.innerWidth - WIDTH - 12,
        ),
      };
    })()
    : { width: WIDTH, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  // The bar is about FINISHING, so it only exists where there is something
  // to finish. A tour has no progress to make - it is read, not completed -
  // and a progress bar on it would imply otherwise.
  const essentials = mode === 'setup' ? steps.filter(x => !x.optional) : [];
  const doneCount = essentials.filter(x => x.done).length;
  // The whole path, on demand. The progress bar says HOW FAR; this says WHAT
  // the steps are, which is the question somebody opening the guide on a
  // finished workspace is actually asking.
  const [listOpen, setListOpen] = useState(false);

  return (
    <div
      className="fixed z-[61] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-800"
      style={style}
      role="dialog"
      aria-label={`${mode === 'tour' ? 'Tour' : 'Setup'} step ${index + 1}: ${step.title}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
            {mode === 'tour' ? 'Tour' : 'Step'} {index + 1} of {steps.length}
            {step.optional && ' · optional'}
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-slate-900 dark:text-slate-100">
            {step.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => onClose(false)}
          className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
          aria-label="Close the guide"
        >
          &times;
        </button>
      </div>

      {justDone && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
          <strong>Done.</strong>{' '}
          {step.count > 0
            ? `${step.count} in place.`
            : 'Nothing more needed here.'}
        </p>
      )}

      {/* The explanation stays even once the step is done. Somebody who
          already has a working workspace opens this to LEARN the order, and a
          row of green ticks teaches nobody anything. */}
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{step.body}</p>
      {step.action && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
          {step.action}
        </p>
      )}
      {!rect && !searching && step.anchor && (
        // Said plainly rather than pretending: the control could not be found,
        // so the words have to carry the step on their own.
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          The button is not on screen &mdash; it may be under a tab that is closed.
          Follow the instruction above; this step still ticks itself off when the
          work is done.
        </p>
      )}
      {searching && (
        <p className="mt-2 text-xs text-slate-400">Finding it on the page&hellip;</p>
      )}

      {/* Progress through the essentials only, and only while setting up.
          The optional steps must not make a finished workspace look
          unfinished, and a tour has nothing to finish at all. */}
      {essentials.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5" aria-hidden>
          {essentials.map(x => (
            <span
              key={x.key}
              className={`h-1.5 flex-1 rounded-full ${
                x.done ? 'bg-emerald-500'
                  : x.key === step.key ? 'bg-blue-500'
                    : 'bg-slate-200 dark:bg-slate-600'
              }`}
            />
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {mode === 'tour'
            ? 'Nothing to finish here - this is a walk round the app.'
            : `${doneCount} of ${essentials.length} essentials done`}
        </p>
        <button
          type="button"
          onClick={() => setListOpen(v => !v)}
          className="text-xs font-medium text-blue-600 underline decoration-dotted hover:decoration-solid dark:text-blue-400"
        >
          {listOpen ? 'Hide the list' : 'All steps'}
        </button>
      </div>

      {listOpen && (
        <ol className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-slate-200 p-1 dark:border-slate-700">
          {steps.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => { setListOpen(false); onGo(i); }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-700/60 ${
                  i === index ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                }`}
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  s.done
                    ? 'bg-emerald-500 text-white'
                    : i === index
                      ? 'bg-blue-500 text-white'
                      : 'bg-slate-200 text-slate-500 dark:bg-slate-600 dark:text-slate-300'
                }`}>
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
                  {s.title}
                </span>
                {s.optional && (
                  <span className="shrink-0 text-[10px] text-slate-400">optional</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onClose(true)}
            className="text-xs text-slate-400 underline decoration-dotted hover:text-slate-600 dark:hover:text-slate-200"
          >
            {mode === 'tour' ? 'Close' : 'Skip for now'}
          </button>
          {index > 0 && (
            <button
              type="button"
              onClick={onRestart}
              className="text-xs text-slate-400 underline decoration-dotted hover:text-slate-600 dark:hover:text-slate-200"
            >
              Start over
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onGo(index - 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => (index + 1 < steps.length ? onGo(index + 1) : onClose(false))}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            {index + 1 < steps.length ? 'Next' : 'Finish'}
          </button>
        </div>
      </div>
    </div>
  );
}
