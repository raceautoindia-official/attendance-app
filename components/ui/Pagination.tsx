'use client';

import { cn } from '@/lib/cn';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export default function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages: (number | '…')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('…');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push('…');
    pages.push(totalPages);
  }

  const btn = 'px-3 py-1.5 text-sm rounded-lg border transition-colors';
  const inactive = 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className={cn('flex items-center justify-center gap-1', className)}>
      <button onClick={() => onPageChange(page - 1)} disabled={page === 1} className={cn(btn, inactive)}>‹</button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-2 text-slate-400">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p as number)}
            className={cn(
              btn,
              p === page
                ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                : inactive,
            )}
          >
            {p}
          </button>
        ),
      )}
      <button onClick={() => onPageChange(page + 1)} disabled={page === totalPages} className={cn(btn, inactive)}>›</button>
    </div>
  );
}
