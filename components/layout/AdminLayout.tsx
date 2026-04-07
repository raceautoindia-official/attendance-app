'use client';

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

const TITLE: Record<string, string> = {
  '/overview': 'Overview',
  '/employees': 'Employees',
  '/attendance': 'Attendance',
  '/schedules': 'Schedules',
  '/leaves': 'Leave Management',
  '/locations': 'Locations',
  '/reports': 'Reports',
};

function getTitle(pathname: string): string {
  for (const [prefix, label] of Object.entries(TITLE)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return label;
  }
  return 'Admin';
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar title={getTitle(pathname)} />
        <main className="flex-1 p-4 md:p-6 pb-20 md:pb-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
