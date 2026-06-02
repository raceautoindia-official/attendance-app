import { cn } from '@/lib/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
  as?: React.ElementType;
}

export default function Card({ children, className, padding = true, as: Tag = 'div' }: CardProps) {
  return (
    <Tag
      className={cn(
        'bg-white dark:bg-slate-800',
        'border border-slate-200 dark:border-slate-700',
        'rounded-xl shadow-sm',
        padding && 'p-6',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
