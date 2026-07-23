'use client';

import { useQuery } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Spinner from '@/components/ui/Spinner';
import type { ApiResponse } from '@/lib/types';

interface QuotaRow {
  casual_total: number;
  sick_total: number;
  earned_total: number;
  casual_used: number;
  sick_used: number;
  earned_used: number;
  has_quota: boolean;
}

/** The logged-in employee's leave balance for the current year. */
export default function LeaveBalanceCard() {
  const year = new Date().getFullYear();
  const { data, isLoading } = useQuery({
    queryKey: ['leave-quotas', 'self', year],
    queryFn: async () => {
      const res = await fetch(`/api/leave-quotas?year=${year}`);
      return res.json() as Promise<ApiResponse<{ quotas: QuotaRow[] }>>;
    },
  });

  const quota = data?.data?.quotas?.[0];

  return (
    <Card>
      <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-4">
        Leave Balance {year}
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : !quota ? (
        <p className="text-sm text-slate-400 italic">No leave quota available.</p>
      ) : !quota.has_quota ? (
        <p className="text-sm text-slate-400 italic">
          Your {year} leave quota has not been set yet — contact your admin.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {([
            ['Casual', quota.casual_total, quota.casual_used],
            ['Sick', quota.sick_total, quota.sick_used],
            ['Earned', quota.earned_total, quota.earned_used],
          ] as const).map(([label, total, used]) => (
            <div key={label}>
              <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                {Math.max(0, Number(total) - Number(used))}
                <span className="text-xs font-normal text-slate-400"> / {Number(total)} left</span>
              </p>
              <p className="text-xs text-slate-400 mt-0.5">{Number(used)} used</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
