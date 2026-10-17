'use client';

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import SectionTabs from './SectionTabs';
import TopBar from './TopBar';
import ChatPanel from '@/components/chat/ChatPanel';
import { titleForPath } from '@/lib/nav';

/**
 * The admin shell: rail, title, tab strip, content.
 *
 * The title used to come from a second hard-coded list of ten paths, which
 * meant eleven of the twenty-one pages were titled "Admin" - including both
 * pages that were missing from the menu. It now comes from lib/nav.ts, the
 * same definition the rail and the tabs read, so a page cannot exist in the
 * navigation and be nameless in the header.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar title={titleForPath(pathname)} />
        {/* Between the title and the content, because it belongs to the
            section rather than to the page: the strip stays put while the
            thing under it changes. */}
        <SectionTabs />
        <main className="flex-1 p-4 md:p-6 pb-20 md:pb-6 overflow-auto">
          {children}
        </main>
      </div>
      {/* Renders nothing unless the signed-in user is a super_admin. */}
      <ChatPanel />
    </div>
  );
}
