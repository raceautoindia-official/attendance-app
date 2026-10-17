'use client';

/**
 * components/ui/Drawer.tsx — a side panel, in place of a centred modal.
 *
 * The reason for the change is visibility: a modal covers the middle of the
 * screen, which is where the list you were working in lives. A drawer takes
 * the right-hand edge and leaves that list legible behind it, so editing a row
 * does not mean losing sight of the rows around it.
 *
 * Deliberately API-compatible with Modal — same `open`, `onClose`, `title`,
 * `size`, `children` — so the eighteen call sites move across by changing one
 * word, and a half-finished migration still compiles.
 *
 * ACCESSIBILITY IS THE POINT, NOT A GARNISH. A drawer without focus management
 * is worse than the modal it replaced: the content behind stays reachable by
 * Tab, so a keyboard user ends up typing into a form they cannot see. This
 * one traps focus while open, restores it to whatever opened the drawer on
 * close, dismisses on Escape, marks itself aria-modal, and hides the rest of
 * the page from assistive technology via inert-style semantics.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { markDialogOpen } from '@/lib/dialogOpen';
import { cn } from '@/lib/cn';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Shown under the title — what this panel is for, when that is not obvious. */
  description?: string;
  children: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Pinned to the bottom, outside the scrolling area, so actions stay reachable. */
  footer?: ReactNode;
}

const SIZE: Record<NonNullable<DrawerProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-3rem)]',
};

/** Everything focusable, in document order. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Drawer({
  open, onClose, title, description, children, className, size = 'md', footer,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  /**
   * onClose, held in a ref so the focus effect below can depend on `open`
   * ALONE.
   *
   * THIS IS NOT A MICRO-OPTIMISATION. Every one of the 39 call sites passes an
   * inline arrow, so `onClose` is a new function on every render. With it in
   * the dependency array the effect tore down and re-ran on every render -
   * which for a controlled input means every keystroke: the cleanup handed
   * focus back to the button that opened the drawer, the effect then moved it
   * to the drawer's FIRST field, and the character you typed went somewhere
   * else. Every form in this app is a drawer, so "typing does not work" was
   * true everywhere at once.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    // Remember what had focus so it can be handed back. Without this, closing
    // a drawer drops focus to the top of the document and a keyboard user has
    // to tab all the way back to the row they were on.
    returnFocusTo.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first thing inside, or the panel itself when it holds nothing
    // focusable — never leave focus behind on the page underneath.
    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap at both ends, so Tab can never reach the page behind.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    // Says a dialog is open, for anything that has to get out of its way -
    // the setup guide dims the page from above z-50 and must not dim a form.
    const releaseDialog = markDialogOpen();
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      releaseDialog();
      returnFocusTo.current?.focus?.();
    };
    // `open` only. See the comment on onCloseRef above - this is the whole bug.
  }, [open]);

  if (!open) return null;

  const labelId = title ? 'drawer-title' : undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Dimmed, but lighter than a modal backdrop: the list behind is meant to
          stay readable, which is the whole reason for using a drawer. */}
      <div
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className={cn(
          'relative flex h-full w-full flex-col bg-white shadow-2xl outline-none',
          'dark:bg-slate-900',
          'motion-safe:animate-[drawer-in_180ms_ease-out]',
          SIZE[size],
          className,
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
            <div className="min-w-0">
              {title && (
                <h2 id={labelId} className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {title}
                </h2>
              )}
              {description && (
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="border-t border-slate-200 px-5 py-3 dark:border-slate-700">{footer}</div>
        )}
      </div>

    </div>
  );
}
