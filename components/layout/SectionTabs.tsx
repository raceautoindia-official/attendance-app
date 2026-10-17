'use client';

/**
 * The second level of navigation: the pages inside the current section.
 *
 * This is the half of the rail change that keeps everything reachable. The rail
 * went from eighteen entries to six; the eighteen pages are all still here, as
 * tabs, one strip under the title.
 *
 * Each tab is a REAL ROUTE, not a panel. A tab is therefore bookmarkable, it
 * can be linked to from an email, the back button works through it, and no page
 * had to be rewritten to become one. The pattern is already proven on
 * /organisation, which is four views behind one entry and is the clearest
 * screen in the app.
 *
 * Renders nothing when the section holds only one page - a strip with one tab
 * in it is furniture, not navigation.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useNavAccess } from '@/lib/useNavAccess';
import { visibleSections, sectionForPath, itemForPath } from '@/lib/nav';

export default function SectionTabs() {
  const pathname = usePathname();
  const access = useNavAccess();

  const sections = visibleSections(access);
  const section = sectionForPath(pathname, sections);
  if (!section || section.items.length < 2) return null;

  const current = itemForPath(pathname, sections);

  return (
    <div className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      {/* Scrolls sideways rather than wrapping: five tabs fit a laptop and not
          a phone, and a strip that reflows to two rows moves the content down
          by a line on exactly the screens with least room. */}
      <nav
        aria-label={`${section.label} pages`}
        className="flex gap-1 overflow-x-auto px-4 md:px-6"
      >
        {section.items.map(item => {
          const active = current?.href === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
