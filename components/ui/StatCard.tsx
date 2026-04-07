import { cn } from '@/lib/cn';
import Card from './Card';
import Spinner from './Spinner';

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info';

interface StatCardProps {
  label: string;
  value: string | number;
  subLabel?: string;
  icon?: React.ReactNode;
  variant?: Variant;
  loading?: boolean;
  className?: string;
}

const ICON_BG: Record<Variant, string> = {
  default: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  success: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400',
  warning: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400',
  danger:  'bg-red-100  text-red-600  dark:bg-red-900/40  dark:text-red-400',
  info:    'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400',
};

export default function StatCard({
  label, value, subLabel, icon, variant = 'default', loading, className,
}: StatCardProps) {
  return (
    <Card className={cn('flex items-center gap-4', className)}>
      {icon && (
        <div className={cn('flex-shrink-0 p-3 rounded-xl', ICON_BG[variant])}>
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">
          {label}
        </p>
        {loading ? (
          <Spinner className="w-6 h-6 mt-1 text-slate-400" />
        ) : (
          <p className="mt-0.5 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</p>
        )}
        {subLabel && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subLabel}</p>
        )}
      </div>
    </Card>
  );
}
