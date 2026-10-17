'use client';

/**
 * The navigation rail — six sections, not eighteen pages.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This listed all eighteen admin pages, in five collapsible groups. The count
 * was not really the problem: FIVE of the entries meant "somebody is waiting on
 * a decision from me" (Notifications, Permissions, Regularisations, Review, and
 * the exception strip on Attendance) and THREE meant "what did people work",
 * with nothing on screen to say which to open. Two pages - Review and
 * Regularisations - had no entry at all, so two finished features could only be
 * reached by typing a URL.
 *
 * Now each entry is a SECTION, and the pages inside it are tabs rendered by
 * SectionTabs at the top of the content. Every page kept its own route, so
 * every bookmark and in-app link still works; the tab strip is a second level
 * of navigation, not a rewrite.
 *
 * The group-collapse state and its localStorage are gone with it. Six entries
 * do not need folding away, and the search box has become the command palette,
 * which can also reach a person by name.
 *
 * Visibility is asked of the permission system now, rather than a hard-coded
 * `superAdminOnly` flag. See `canSee` in lib/nav.ts for why the legacy role is
 * still consulted: nobody holds a role yet, and a navigation change must not be
 * the thing that quietly removes somebody's access.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/lib/useCurrentUser';
import { useNavAccess } from '@/lib/useNavAccess';
import { clearStoredUser } from '@/lib/user';
import {
  visibleSections, sectionForPath, sectionHref, type NavSection,
} from '@/lib/nav';
import { NavIcon } from './navIcons';
import CommandPalette from './CommandPalette';
import type { ApiResponse } from '@/lib/types';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useCurrentUser();
  const access = useNavAccess();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl/Cmd-K from anywhere. On the window rather than on the palette,
  // because the palette is not mounted until it opens - and because the
  // whole point of the shortcut is that it works without the rail being in
  // reach, on a page scrolled a long way down.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sections = visibleSections(access);
  const active = sectionForPath(pathname, sections);

  // How many decisions are waiting. Polled rather than pushed: it only needs to
  // be roughly current, and a socket for one integer is not worth its failure
  // modes. `count=1` skips the exception scan, which is the expensive half.
  const { data: inboxData } = useQuery({
    queryKey: ['inbox', 'count'],
    queryFn: async () => {
      const res = await fetch('/api/inbox?count=1');
      return res.json() as Promise<ApiResponse<{ counts: { decisions: number } }>>;
    },
    refetchInterval: 60_000,
  });
  const pendingCount = inboxData?.data?.counts?.decisions ?? 0;

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    clearStoredUser();
    router.push('/login');
  }

  // Five across a phone's width is already tight; the sixth would make every
  // target too narrow to hit. Settings is the one left out, because it is
  // touched once a quarter and never from a phone.
  const mobileSections = sections.slice(0, 5);

  return (
    <>
      {paletteOpen && <CommandPalette onOpenChange={setPaletteOpen} />}

      <aside className="hidden md:flex md:flex-col w-56 min-h-screen bg-slate-900 dark:bg-slate-950 border-r border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-800">
          {/* The square mark only — the rail is 32px of space and the wordmark
              is unreadable at that size. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/worklens-mark.png"
            alt=""
            className="w-8 h-8 rounded-lg flex-shrink-0 object-contain"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <div className="min-w-0">
            <span className="text-white font-semibold text-sm block">WorkLens</span>
            {user && (
              <span className="text-slate-400 text-xs capitalize">
                {user.role === 'super_admin' ? 'Super Admin' : 'Manager'}
              </span>
            )}
          </div>
        </div>

        {/* The search box became a button. One keystroke reaches everything -
            pages and people - and a second search field in the rail would just
            be a worse version of the same thing. */}
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 text-left text-sm text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-300"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="flex-1">Search</span>
            <kbd className="rounded border border-slate-600 px-1 text-[10px] text-slate-500">Ctrl K</kbd>
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
          {sections.map(section => (
            <RailEntry
              key={section.key}
              section={section}
              active={active?.key === section.key}
              pendingCount={pendingCount}
            />
          ))}
        </nav>

        {user && (
          <div className="px-4 py-3 border-t border-slate-800 space-y-2">
            <p className="text-xs text-slate-400 truncate">{user.name}</p>
            <p className="text-xs text-slate-600 truncate">{user.emp_id}</p>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-xs text-slate-500 hover:text-red-400 transition-colors w-full"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        )}
      </aside>

      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-slate-900 dark:bg-slate-950 border-t border-slate-800 flex">
        {mobileSections.map(section => (
          <Link
            key={section.key}
            href={sectionHref(section)}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors',
              active?.key === section.key ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {/* A dot, not a number: the bar has no room for one, and "there is
                something waiting" is all it needs to say. */}
            <span className="relative">
              <NavIcon name={section.icon} />
              {section.badge && pendingCount > 0 && (
                <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
              )}
            </span>
            <span>{section.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

function RailEntry({ section, active, pendingCount }: {
  section: NavSection; active: boolean; pendingCount: number;
}) {
  return (
    <Link
      href={sectionHref(section)}
      aria-current={active ? 'page' : undefined}
      // Every rail entry is a place the tour can point at. Derived from the
      // section key rather than listed somewhere else, so a new section is
      // anchored the moment it appears.
      data-tour={`nav-${section.key}`}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
      )}
    >
      <NavIcon name={section.icon} />
      <span className="flex-1">{section.label}</span>
      {section.badge && pendingCount > 0 && (
        <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-semibold text-white">
          {pendingCount > 99 ? '99+' : pendingCount}
        </span>
      )}
    </Link>
  );
}
