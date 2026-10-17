/**
 * lib/nav.ts — one definition of the admin navigation.
 *
 * WHY THIS IS DATA AND NOT JSX
 * ----------------------------
 * Four things need to agree about what exists and who may see it: the sidebar
 * rail, the tab strip inside a section, the command palette, and the bottom bar
 * on a phone. When each held its own list they drifted - two pages (`/review`
 * and `/regularisations`) ended up in none of them, which made two finished
 * features unreachable except by typing the URL.
 *
 * So the lists live here, as plain data with no React in them, and every
 * surface renders from this. It is also why the icons are KEYS rather than
 * elements: a module that imports JSX cannot be read by a test script without
 * dragging a renderer in behind it.
 *
 * WHY SECTIONS
 * ------------
 * Eighteen rail entries is the complaint, and the count is not the cause. Five
 * of them meant "somebody is waiting on a decision from me" and three meant
 * "what did people work", with nothing on screen to say which to open. Six
 * sections with tabs underneath says it in the shape of the thing.
 *
 * Each tab stays a REAL ROUTE. Nothing is moved, nothing redirects, every
 * bookmark and every in-app link keeps working - the tab strip is a second
 * level of navigation over the pages that already exist, not a rewrite of them.
 */

export type Scope = 'self' | 'team' | 'department' | 'all';

/** What the signed-in person may do, as the rail needs to know it. */
export interface NavAccess {
  isSuperAdmin: boolean;
  /** True when they hold a role from `employee_roles`, rather than the fallback. */
  explicit: boolean;
  /** `employees.role` — still the source of the fallback. */
  legacyRole: string;
  /** permission key -> widest scope granted. */
  grants: Record<string, Scope>;
}

export interface NavItem {
  href: string;
  label: string;
  /**
   * The permission that governs this page once roles are in use. `null` means
   * anybody who can reach the admin area at all.
   */
  perm: string | null;
  /**
   * Who may open it TODAY, before any role has been granted - mirroring each
   * API's own `requireAuth`.
   *
   * Not redundant with `perm`. Nobody holds a role yet (`employee_roles` is
   * empty), so filtering on permissions alone would hide pages that managers
   * can currently open and use: the Schedules API admits a manager, but
   * `schedule.manage` is not in the manager fallback. A navigation change must
   * not quietly take access away - that is a separate decision, made on the
   * Roles page, deliberately.
   */
  legacyRoles: readonly string[];
  /** One line for the command palette, where there is room to explain. */
  hint?: string;
}

export interface NavSection {
  key: string;
  label: string;
  /** Icon key; the mapping to an element lives in the component. */
  icon: string;
  /** True for the section whose rail entry carries a count. */
  badge?: boolean;
  items: readonly NavItem[];
}

const ADMINS = ['manager', 'super_admin'] as const;
const SUPER = ['super_admin'] as const;

export const SECTIONS: readonly NavSection[] = [
  {
    key: 'today',
    label: 'Today',
    icon: 'today',
    items: [
      { href: '/overview', label: 'Today', perm: null, legacyRoles: ADMINS,
        hint: 'Who is in, who is late, what needs attention' },
    ],
  },
  {
    key: 'inbox',
    label: 'Inbox',
    icon: 'inbox',
    badge: true,
    items: [
      { href: '/inbox', label: 'Needs a decision', perm: null, legacyRoles: ADMINS,
        hint: 'Every request and review waiting on somebody, in one queue' },
      { href: '/notifications', label: 'Off-site & requests', perm: 'attendance.view', legacyRoles: ADMINS,
        hint: 'Clock-ins from away from site, and what was decided' },
      { href: '/regularisations', label: 'Corrections', perm: 'attendance.edit', legacyRoles: ADMINS,
        hint: 'Requests to correct a recorded day' },
      { href: '/review', label: 'Month review', perm: 'reports.view', legacyRoles: ADMINS,
        hint: 'What is worth noticing before the month is closed' },
    ],
  },
  {
    key: 'people',
    label: 'People',
    icon: 'people',
    items: [
      { href: '/employees', label: 'Employees', perm: 'employee.view', legacyRoles: ADMINS,
        hint: 'The list, each profile, bank and identity details' },
      { href: '/onboarding', label: 'Joining & leaving', perm: 'employee.manage', legacyRoles: ADMINS,
        hint: 'Induction checklists and exit checklists' },
      { href: '/organisation', label: 'Organisation', perm: 'org.manage', legacyRoles: SUPER,
        hint: 'Departments, teams, grades, who sits where, the company profile' },
      // Beside the company profile rather than in Settings: a work site IS a
      // company address, and the two were being typed separately.
      { href: '/locations', label: 'Work sites', perm: 'location.manage', legacyRoles: SUPER,
        hint: 'Where the company works from, with the geofence for each' },
      { href: '/documents', label: 'Documents', perm: 'documents.view', legacyRoles: ADMINS,
        hint: 'Papers held per person, and who is missing what' },
    ],
  },
  {
    key: 'time',
    label: 'Time',
    icon: 'time',
    items: [
      { href: '/attendance', label: 'Attendance', perm: 'attendance.view', legacyRoles: ADMINS,
        hint: 'Clock-ins and clock-outs, day by day' },
      { href: '/leaves', label: 'Leave', perm: 'leave.view', legacyRoles: ADMINS,
        hint: 'Leave taken, and what is left of the entitlement' },
      { href: '/permissions', label: 'Permissions', perm: 'permission.approve', legacyRoles: ADMINS,
        hint: 'Short time-off requests and the hours they use up' },
      { href: '/schedules', label: 'Schedules', perm: 'schedule.manage', legacyRoles: ADMINS,
        hint: 'Shifts, and who works which one' },
      { href: '/holidays', label: 'Holidays', perm: 'holiday.manage', legacyRoles: SUPER,
        hint: 'The holiday calendar, by country' },
    ],
  },
  {
    key: 'insight',
    label: 'Insight',
    icon: 'insight',
    items: [
      { href: '/reports', label: 'Reports & hours', perm: 'reports.view', legacyRoles: ADMINS,
        hint: 'Required against worked, per person, with exports' },
      { href: '/performance', label: 'Performance', perm: 'performance.view', legacyRoles: ADMINS,
        hint: 'Attendance, punctuality and hours, scored' },
      { href: '/live-tracking', label: 'Live tracking', perm: 'tracking.view', legacyRoles: ADMINS,
        hint: 'Where people are during a live session' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    items: [
      { href: '/policies', label: 'Policies', perm: 'policy.manage', legacyRoles: SUPER,
        hint: 'The rules a group of people is measured by' },
      { href: '/access', label: 'Roles & access', perm: 'roles.manage', legacyRoles: SUPER,
        hint: 'Who may see and do what' },
      { href: '/audit-log', label: 'Audit log', perm: 'audit.view', legacyRoles: SUPER,
        hint: 'Every change, who made it and when' },
    ],
  },
];

/**
 * Routes that are not tabs but belong to a section for highlighting.
 *
 * `/hours` only forwards to `/reports`, and an employee page opened from a
 * report is still the reader being in Insight. Without this the rail goes
 * blank mid-journey, which reads as "you have left the app".
 */
const ALIASES: Record<string, string> = {
  '/hours': '/reports',
};

/** Can this person open this page at all. */
export function canSee(item: NavItem, access: NavAccess): boolean {
  if (access.isSuperAdmin) return true;
  // Holding a role means the role decides, including when it grants nothing.
  if (access.explicit) return item.perm === null || item.perm in access.grants;
  return item.legacyRoles.includes(access.legacyRole);
}

/**
 * The sections to show, each carrying only the tabs this person may open.
 *
 * A section with nothing visible in it is dropped rather than shown empty: a
 * rail entry that leads to a refusal is worse than one that is not there.
 */
export function visibleSections(access: NavAccess): NavSection[] {
  return SECTIONS
    .map(s => ({ ...s, items: s.items.filter(i => canSee(i, access)) }))
    .filter(s => s.items.length > 0);
}

/** Where a rail entry goes: its first tab this person may open. */
export function sectionHref(section: NavSection): string {
  return section.items[0]?.href ?? '/overview';
}

/**
 * Which section a path belongs to, by longest matching href.
 *
 * Longest first because `/reports` and `/review` share a prefix with nothing,
 * but `/employees` and `/employees/123` do - and a child page must highlight
 * its parent rather than nothing.
 */
export function sectionForPath(pathname: string, sections: readonly NavSection[] = SECTIONS): NavSection | null {
  const path = ALIASES[pathname] ?? pathname;
  let best: { section: NavSection; length: number } | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      const hit = path === item.href || path.startsWith(item.href + '/');
      if (hit && (!best || item.href.length > best.length)) {
        best = { section, length: item.href.length };
      }
    }
  }
  return best?.section ?? null;
}

/** The tab within a section that matches a path, for the active state. */
export function itemForPath(pathname: string, sections: readonly NavSection[] = SECTIONS): NavItem | null {
  const path = ALIASES[pathname] ?? pathname;
  let best: { item: NavItem; length: number } | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      const hit = path === item.href || path.startsWith(item.href + '/');
      if (hit && (!best || item.href.length > best.length)) {
        best = { item, length: item.href.length };
      }
    }
  }
  return best?.item ?? null;
}

/** Every visible page, flattened — what the command palette searches. */
export function allVisibleItems(access: NavAccess): Array<NavItem & { section: string }> {
  return visibleSections(access).flatMap(s => s.items.map(i => ({ ...i, section: s.label })));
}

/**
 * The page title, which used to be a second hard-coded list that fell back to
 * the word "Admin" for eleven of the twenty-one pages.
 */
export function titleForPath(pathname: string): string {
  return itemForPath(pathname)?.label ?? 'Admin';
}
