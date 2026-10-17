'use client';

/**
 * DEPRECATED - use `Drawer` instead. Nothing imports this any more.
 *
 * Every centred modal in this app was replaced with a side drawer on
 * 2026-10-10. The reason was visibility: a modal covers the middle of the
 * screen, which is where the list you were working in lives, so editing a row
 * meant losing sight of the rows around it.
 *
 * Kept here rather than deleted because `Drawer` was written API-compatible
 * with it - same open/onClose/title/size/children - so this file documents
 * the shape that was migrated FROM, and a half-finished revert would still
 * compile. If you find yourself reaching for it, you probably want
 * components/ui/Drawer.tsx.
 */

import { useEffect } from 'react';
import { markDialogOpen } from '@/lib/dialogOpen';
import { cn } from '@/lib/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
};

export default function Modal({ open, onClose, title, children, className, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    // See lib/dialogOpen: the setup guide steps aside while this is up.
    const releaseDialog = markDialogOpen();
    return () => { document.body.style.overflow = ''; releaseDialog(); };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        className={cn(
          'w-full bg-white dark:bg-slate-800 rounded-xl shadow-xl',
          'border border-slate-200 dark:border-slate-700',
          'max-h-[90vh] flex flex-col',
          SIZE[size],
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors rounded"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
