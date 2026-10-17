'use client';

/**
 * components/ui/Wizard.tsx — one thing at a time.
 *
 * The employee form asked for everything at once: identity, role, shift,
 * location, policy, geofencing, work mode. A new administrator met twenty
 * fields with no indication which three actually mattered, and the usual
 * outcome is a record created with the easy half filled in.
 *
 * Three rules this enforces, and each exists because of how these go wrong:
 *
 *   GOING BACK NEVER LOSES ANYTHING. Every step's values live in the caller's
 *   state, not in the step. A wizard that forgets what you typed when you step
 *   back teaches people never to step back, and then they guess instead.
 *
 *   A STEP IS VALIDATED WHEN YOU LEAVE IT, not at the end. Being told on step
 *   five that step one was wrong means redoing the walk.
 *
 *   NOTHING IS FINAL. The last step says so. The reason people stall on step
 *   one of a form is the belief that a wrong answer is permanent, and almost
 *   none of these are.
 *
 * Steps may be optional: `canSkip` lets somebody create the person now and
 * place them later, which is better than a half-invented department.
 */

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import Button from '@/components/ui/Button';

export interface WizardStep {
  key: string;
  title: string;
  /** One line under the title saying what this step is for. */
  hint?: string;
  content: ReactNode;
  /**
   * Return null when the step is good, or a message naming what is wrong.
   * Called when LEAVING the step, not on every render.
   */
  validate?: () => string | null;
  /** Shown as "Skip for now" rather than blocking the walk. */
  canSkip?: boolean;
}

export default function Wizard({
  steps, onFinish, onCancel, finishLabel = 'Create', busy = false, error,
}: {
  steps: WizardStep[];
  onFinish: () => void;
  onCancel?: () => void;
  finishLabel?: string;
  busy?: boolean;
  /** An error from the server, shown against the whole wizard. */
  error?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));

  const step = steps[index];
  const isLast = index === steps.length - 1;

  function goTo(next: number) {
    setStepError(null);
    setIndex(next);
    setVisited(v => new Set(v).add(next));
  }

  function forward() {
    const problem = step.validate?.() ?? null;
    if (problem) { setStepError(problem); return; }
    if (isLast) onFinish();
    else goTo(index + 1);
  }

  return (
    <div className="space-y-4">
      {/* The stepper doubles as navigation, but only backwards to somewhere
          already visited. Jumping ahead would skip the validation that makes
          the walk worth anything. */}
      <ol className="flex flex-wrap items-center gap-1">
        {steps.map((s, i) => {
          const done = i < index;
          const current = i === index;
          const reachable = visited.has(i) && i < index;
          return (
            <li key={s.key} className="flex items-center gap-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && goTo(i)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  current && 'bg-blue-600 text-white',
                  done && 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300',
                  !current && !done && 'text-slate-400',
                )}
              >
                <span className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                  current && 'bg-white/25',
                  done && 'bg-emerald-600 text-white',
                  !current && !done && 'border border-slate-300 dark:border-slate-600',
                )}>
                  {done ? '✓' : i + 1}
                </span>
                {s.title}
              </button>
              {i < steps.length - 1 && <span className="text-slate-300 dark:text-slate-600">&rsaquo;</span>}
            </li>
          );
        })}
      </ol>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{step.title}</h3>
        {step.hint && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{step.hint}</p>
        )}
      </div>

      {(stepError || error) && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {stepError ?? error}
        </p>
      )}

      <div>{step.content}</div>

      {isLast && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
          None of this is final. Everything here can be changed afterwards from the
          relevant page, so it is better to create the record now than to guess at
          an answer to keep moving.
        </p>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
        <div>
          {index > 0 ? (
            <Button variant="secondary" onClick={() => goTo(index - 1)}>Back</Button>
          ) : onCancel ? (
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {step.canSkip && !isLast && (
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              className="text-xs font-medium text-slate-500 underline decoration-dotted hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Skip for now
            </button>
          )}
          <Button onClick={forward} loading={busy}>
            {isLast ? finishLabel : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
}
