import { query } from '@/lib/db';
import { can, type AccessContext } from '@/lib/access';

/**
 * Where to start, for somebody who has just been handed an empty workspace.
 *
 * WHY THIS IS NOT A TUTORIAL
 * --------------------------
 * A tutorial tells you what the buttons are called and then leaves you exactly
 * where it found you. What a new administrator is actually stuck on is ORDER:
 * an employee cannot be created without a department and a work site, a policy
 * is useless without a shift to name, and the hours ledger is empty until all
 * of it exists. The order is not discoverable from the menu, because the menu
 * is organised by subject rather than by what has to happen first.
 *
 * So this is a list of real steps, and every one of them is marked done by
 * READING THE WORKSPACE - a company exists, a shift exists, somebody has a
 * policy. Nothing here records that a tooltip was dismissed. That distinction
 * is the whole design:
 *
 *   - it cannot lie. A guide that ticks a step because the overlay was clicked
 *     tells an administrator they have a shift when they do not.
 *   - it survives everything. Close the browser, change machine, hand the job
 *     to somebody else mid-way: the guide picks up where the DATA is.
 *   - it needs no table, no migration and no cleanup, which also means there
 *     is no stored progress to contradict what is really there.
 *   - it ends by itself. Once the required steps are done nothing nags, and
 *     the button stays for whoever wants to see what is left.
 *
 * ORDER OF THE REQUIRED STEPS
 * ---------------------------
 * Each one is a genuine prerequisite of the next, not a preference:
 *
 *   company   -> who the employer is; sites and departments hang off it
 *   work site -> where people clock in; an employee needs one to be rostered
 *   department-> how people are grouped; the employee form requires it
 *   shift     -> the hours a day is measured against
 *   policy    -> the rules, which name a default shift
 *   employee  -> somebody to hold all of it
 *
 * The optional ones after them are real work too, but nothing is broken while
 * they are undone, so they are not allowed to make the list look unfinished.
 */

export interface SetupStep {
  key: string;
  /** The imperative, as it appears on the card. */
  title: string;
  /** One line on why this is where it is in the order. */
  why: string;
  /** What to actually do, once the page is open. */
  action: string;
  /** The page it is done on. */
  href: string;
  /**
   * The element to spotlight, matched as `[data-tour="..."]`. Null means the
   * step has no single control - the card then explains and points at nothing
   * rather than highlighting something arbitrary.
   */
  anchor: string | null;
  /** Whether the chain is broken without it. */
  required: boolean;
  /** The permission needed. A step somebody cannot do is not shown to them. */
  perm: string | null;
  /** How many of the thing exist now. */
  count: number;
  done: boolean;
}

/**
 * The tour, for somebody who did not build this workspace.
 *
 * The setup list answers "what do I have to create". Somebody joining a
 * company where all of that was done years ago has the opposite problem:
 * nothing is missing, so the setup list is six green ticks, and they still
 * have no idea where the day's work happens or what the screens are for.
 *
 * So these are PLACES, not tasks. None of them is ever done or undone -
 * there is nothing to finish - and the tour never advances by itself,
 * because there is no event to wait for. It is read at the reader's pace.
 */
export interface TourStop {
  key: string;
  title: string;
  /** What this screen is for, in one or two sentences. */
  what: string;
  href: string;
  anchor: string | null;
  perm: string | null;
}

const TOUR: TourStop[] = [
  {
    key: 'today',
    title: 'Today is where the day is',
    what: 'Who is in, who is late, who has not clocked in at all. Start here each morning; everything on it is about today only.',
    href: '/overview',
    anchor: 'nav-today',
    perm: null,
  },
  {
    key: 'inbox',
    title: 'The inbox is what is waiting on you',
    what: 'Leave to approve, corrections to decide, permission requests, and the alerts the rules raised. If something needs a person, it is here rather than scattered over five screens.',
    href: '/inbox',
    anchor: 'nav-inbox',
    perm: null,
  },
  {
    key: 'people',
    title: 'People holds the records',
    what: 'Employees and their details, joining and leaving, the organisation itself, work sites and documents. Anything about a person rather than a day.',
    href: '/employees',
    anchor: 'nav-people',
    perm: 'employee.view',
  },
  {
    key: 'time',
    title: 'Time is the record of what happened',
    what: 'Attendance day by day, leave, permissions, schedules and the holiday calendar. This is where a wrong day gets corrected.',
    href: '/attendance',
    anchor: 'nav-time',
    perm: 'attendance.view',
  },
  {
    key: 'insight',
    title: 'Insight is what it adds up to',
    what: 'Reports and the hours ledger, punctuality scores, live tracking. It is also where a month is closed once it has been reviewed, which freezes the figures.',
    href: '/reports',
    anchor: 'nav-insight',
    perm: 'reports.view',
  },
  {
    key: 'settings',
    title: 'Settings is the rules themselves',
    what: 'Policies decide what counts as late, as a half day, as overtime. Roles decide who sees what. Changing one of these changes figures for everybody it applies to.',
    href: '/policies',
    anchor: 'nav-settings',
    perm: 'policy.manage',
  },
];

export interface SetupState {
  steps: SetupStep[];
  /** The walkthrough, for somebody who did not build this workspace. */
  tour: TourStop[];
  /** Required steps still undone, in order. The first is "what to do next". */
  remaining: SetupStep[];
  requiredDone: number;
  requiredTotal: number;
  /**
   * Nothing has been set up at all. Used to decide whether to OPEN the guide
   * rather than merely offer it - interrupting somebody with a working
   * workspace would be rude, and interrupting somebody with an empty one is
   * the entire point.
   */
  isNewWorkspace: boolean;
}

/** Everything the steps are judged by, in one round trip. */
interface Counts {
  companies: number;
  locations: number;
  departments: number;
  teams: number;
  grades: number;
  shifts: number;
  policies: number;
  employees: number;
  rostered: number;
  on_policy: number;
  holidays: number;
  roles: number;
}

async function counts(): Promise<Counts> {
  const [row] = await query<Counts>(
    `SELECT
       (SELECT COUNT(*) FROM companies WHERE is_active = TRUE) AS companies,
       (SELECT COUNT(*) FROM locations WHERE is_active = TRUE) AS locations,
       (SELECT COUNT(*) FROM departments WHERE is_active = TRUE) AS departments,
       (SELECT COUNT(*) FROM teams WHERE is_active = TRUE) AS teams,
       (SELECT COUNT(*) FROM grades WHERE is_active = TRUE) AS grades,
       (SELECT COUNT(*) FROM shifts) AS shifts,
       (SELECT COUNT(*) FROM policies WHERE is_active = TRUE) AS policies,
       -- The administrator setting all this up is an employee too, and a
       -- workspace containing only them is not a workspace with people in it.
       (SELECT COUNT(*) FROM employees WHERE is_active = TRUE) AS employees,
       (SELECT COUNT(DISTINCT employee_id) FROM employee_schedules
         WHERE effective_to IS NULL) AS rostered,
       (SELECT COUNT(DISTINCT employee_id) FROM employee_policies
         WHERE effective_to IS NULL) AS on_policy,
       (SELECT COUNT(*) FROM holiday_observances WHERE is_observed = TRUE) AS holidays,
       (SELECT COUNT(*) FROM roles WHERE is_active = TRUE AND is_system = FALSE) AS roles`,
  );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    companies: n(row?.companies), locations: n(row?.locations),
    departments: n(row?.departments), teams: n(row?.teams), grades: n(row?.grades),
    shifts: n(row?.shifts), policies: n(row?.policies), employees: n(row?.employees),
    rostered: n(row?.rostered), on_policy: n(row?.on_policy),
    holidays: n(row?.holidays), roles: n(row?.roles),
  };
}

/**
 * The steps, in the order they have to happen.
 *
 * `anchor` names a `data-tour` attribute on the real control. The guide
 * highlights whatever that attribute is on, so moving a button is enough to
 * keep the guide pointing at it - there is no second copy of the layout here
 * to drift out of step with the page.
 */
function describe(c: Counts): SetupStep[] {
  return [
    {
      key: 'company',
      title: 'Add your company',
      why: 'Everything else belongs to a company — work sites, departments, and through them, people.',
      action: 'Open the Company tab and press New company. The legal name is the only thing you must have.',
      href: '/organisation?tab=company',
      anchor: 'company-new',
      required: true,
      perm: 'org.manage',
      count: c.companies,
      done: c.companies > 0,
    },
    {
      key: 'location',
      title: 'Add a work site',
      why: 'A site is where people clock in. Nobody can be rostered until one exists, and the geofence is drawn around it.',
      action: 'Press Add location, give it a name and drop the pin on the building.',
      href: '/locations',
      anchor: 'location-new',
      required: true,
      perm: 'location.manage',
      count: c.locations,
      done: c.locations > 0,
    },
    {
      key: 'department',
      title: 'Add a department',
      why: 'The employee form asks for one, and departments are how the company counts its people.',
      action: 'Press New department. One is enough to start — they can be nested later.',
      href: '/organisation?tab=structure',
      anchor: 'department-new',
      required: true,
      perm: 'org.manage',
      count: c.departments,
      done: c.departments > 0,
    },
    {
      key: 'shift',
      title: 'Create a shift',
      why: 'A shift is the hours a day is measured against. Without one, worked hours have nothing to be short of.',
      action: 'Press New shift and set the start, the end and the working days.',
      href: '/schedules',
      anchor: 'shift-new',
      required: true,
      perm: 'schedule.manage',
      count: c.shifts,
      done: c.shifts > 0,
    },
    {
      key: 'policy',
      title: 'Write a policy',
      why: 'The rules people are held to — late grace, half-day hours, overtime. It names the shift you just made as its default.',
      action: 'Press New policy. Every rule may be left empty, and empty means "behave as before".',
      href: '/policies',
      anchor: 'policy-new',
      required: true,
      perm: 'policy.manage',
      count: c.policies,
      done: c.policies > 0,
    },
    {
      key: 'employee',
      title: 'Add your people',
      why: 'The last step, because it is the one that needs all the others: a department to sit in, a site to clock in at, a shift to work.',
      action: 'Press Add employee and work through the wizard. It asks for the things above, which is why they came first.',
      href: '/employees',
      anchor: 'employee-new',
      required: true,
      perm: 'employee.manage',
      // One person is the administrator themselves, who was created with the
      // workspace. Two is the first real answer.
      count: c.employees,
      done: c.employees > 1,
    },

    // ---- Worth doing, nothing broken until they are ------------------------
    {
      key: 'team',
      title: 'Split a department into teams',
      why: 'Only worth doing when a department is too big to be one group. A team belongs to one department and can have a lead, which is who a manager role is scoped to.',
      action: 'On the Structure tab, press New team and pick its department.',
      href: '/organisation?tab=structure',
      anchor: 'team-new',
      required: false,
      perm: 'org.manage',
      count: c.teams,
      done: c.teams > 0,
    },
    {
      key: 'roster',
      title: 'Put people on their shift',
      why: 'Assigning a policy offers to move everybody onto the shift it names. Until somebody is on a shift, their ledger has no target.',
      action: 'Open a policy, press Assign, pick the people, and accept the shift move it offers.',
      href: '/policies',
      anchor: 'policy-assign',
      required: false,
      perm: 'policy.manage',
      count: c.on_policy,
      done: c.on_policy > 0 && c.rostered > 0,
    },
    {
      key: 'holidays',
      title: 'Mark the holidays you close for',
      why: 'A holiday takes the day out of required hours. Importing a list changes nothing until you tick the sites that actually close.',
      action: 'Import a year, then open a date and tick who closes for it.',
      href: '/holidays',
      anchor: 'holiday-import',
      required: false,
      perm: 'holiday.manage',
      count: c.holidays,
      done: c.holidays > 0,
    },
    {
      key: 'access',
      title: 'Decide who can see what',
      why: 'Until a role is given, everybody falls back on the old all-or-nothing rule. A role is how a manager sees their own team and no further.',
      action: 'Create a role, tick the permissions, then give it to somebody on the People tab.',
      href: '/access',
      anchor: 'role-new',
      required: false,
      perm: 'roles.manage',
      count: c.roles,
      done: c.roles > 0,
    },
  ];
}

/**
 * The guide, for one person.
 *
 * Steps they have no permission for are removed rather than shown locked: a
 * manager who cannot create a company should not be told that setting up the
 * workspace is their job and then refused at the door.
 */
export async function setupState(ctx: AccessContext): Promise<SetupState> {
  const c = await counts();
  const steps = describe(c).filter(s => s.perm === null || can(ctx, s.perm));

  const required = steps.filter(s => s.required);
  const remaining = required.filter(s => !s.done);

  return {
    steps,
    tour: TOUR.filter(t => t.perm === null || can(ctx, t.perm)),
    remaining,
    requiredDone: required.length - remaining.length,
    requiredTotal: required.length,
    // No company, no sites and nobody but the administrator: this workspace
    // has not been started, whatever else happens to exist.
    isNewWorkspace: c.companies === 0 && c.locations === 0 && c.employees <= 1,
  };
}
