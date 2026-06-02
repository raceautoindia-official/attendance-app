import { cn } from '@/lib/cn';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
}

interface TableProps<T extends object> {
  columns: Column<T>[];
  data: T[];
  keyField?: keyof T;
  onSort?: (key: string) => void;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
}

export default function Table<T extends object>({
  columns,
  data,
  keyField = 'id' as keyof T,
  onSort,
  sortKey,
  sortDir,
  emptyMessage = 'No records found.',
  onRowClick,
  rowClassName,
}: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
      <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
        <thead className="bg-slate-50 dark:bg-slate-900/60">
          <tr>
            {columns.map(col => (
              <th
                key={col.key}
                scope="col"
                onClick={() => col.sortable && onSort?.(col.key)}
                className={cn(
                  'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider',
                  'text-slate-500 dark:text-slate-400',
                  col.sortable && 'cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200',
                  col.headerClassName,
                )}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {sortDir === 'asc'
                        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />}
                    </svg>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-slate-800 divide-y divide-slate-100 dark:divide-slate-700/50">
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr
                key={String((row as Record<string, unknown>)[keyField as string] ?? i)}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  'transition-colors',
                  'hover:bg-slate-50 dark:hover:bg-slate-700/40',
                  i % 2 === 1 && 'bg-slate-50/40 dark:bg-slate-800/60',
                  onRowClick && 'cursor-pointer',
                  rowClassName?.(row),
                )}
              >
                {columns.map(col => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-sm text-slate-700 dark:text-slate-300 whitespace-nowrap',
                      col.className,
                    )}
                  >
                    {col.render
                      ? col.render(row, i)
                      : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
