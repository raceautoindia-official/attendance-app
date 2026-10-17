import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';

/**
 * lib/onboarding.ts — joining and leaving, as checklists somebody owns.
 *
 * One module for both directions. Offboarding is the same shape as onboarding
 * — a dated list of tasks with owners — and the only honest difference is
 * which way the person is travelling. Two parallel implementations would be
 * the same logic twice, and the second copy is always the one that rots.
 *
 * TASKS ARE COPIED FROM THE TEMPLATE, NOT JOINED TO IT. Editing a template
 * must not silently rewrite what somebody was asked to do three weeks ago, and
 * a finished checklist has to stay readable as the checklist that was actually
 * finished. The cost is duplicated rows; the alternative is a history that
 * changes when you look at it.
 */

export type Direction = 'onboarding' | 'offboarding';
export type TaskStatus = 'pending' | 'done' | 'not_applicable';
export type OwnerRole = 'hr' | 'manager' | 'it' | 'employee' | 'finance';

export interface TemplateTask {
  id: number;
  title: string;
  description: string | null;
  owner_role: OwnerRole;
  category: string;
  due_offset_days: number;
  is_blocking: boolean;
  sort_order: number;
}

export interface Template {
  id: number;
  name: string;
  direction: Direction;
  description: string | null;
  is_default: boolean;
  is_active: boolean;
  tasks: TemplateTask[];
}

export interface JourneyTask {
  id: number;
  title: string;
  description: string | null;
  owner_role: OwnerRole;
  category: string;
  due_on: string | null;
  is_blocking: boolean;
  status: TaskStatus;
  completed_at: string | null;
  completed_by_name: string | null;
  notes: string | null;
  sort_order: number;
  /** Pending, blocking, and past its date. The only tasks worth chasing. */
  overdue: boolean;
}

export interface Journey {
  id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  direction: Direction;
  anchor_date: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  template_name: string | null;
  notes: string | null;
  tasks: JourneyTask[];
  /** Counts, so a list can show progress without loading every task. */
  total: number;
  done: number;
  blocking_outstanding: number;
  overdue: number;
}

export class OnboardingError extends Error {
  constructor(message: string) { super(message); this.name = 'OnboardingError'; }
}

const today = () => toYmd(new Date());

function addDays(isoDate: string, days: number): string {
  return toYmd(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000));
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(direction?: Direction): Promise<Template[]> {
  const templates = await query<{
    id: number; name: string; direction: Direction; description: string | null;
    is_default: number; is_active: number;
  }>(
    `SELECT id, name, direction, description, is_default, is_active
       FROM onboarding_templates
      ${direction ? 'WHERE direction = ?' : ''}
      ORDER BY direction, is_default DESC, name`,
    direction ? [direction] : [],
  );
  if (templates.length === 0) return [];

  const tasks = await query<
    Omit<TemplateTask, 'is_blocking'> & { template_id: number; is_blocking: number }
  >(
    `SELECT * FROM onboarding_template_tasks
      WHERE template_id IN (${templates.map(() => '?').join(',')})
      ORDER BY sort_order, id`,
    templates.map(t => t.id),
  );

  return templates.map(t => ({
    ...t,
    is_default: Boolean(t.is_default),
    is_active: Boolean(t.is_active),
    tasks: tasks.filter(x => x.template_id === t.id)
      .map(x => ({ ...x, is_blocking: Boolean(x.is_blocking) })),
  }));
}

export async function defaultTemplate(direction: Direction): Promise<Template | null> {
  const all = await listTemplates(direction);
  return all.find(t => t.is_default && t.is_active) ?? all.find(t => t.is_active) ?? null;
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

/**
 * Start somebody's checklist.
 *
 * Refuses a second open journey in the same direction. Two live joining
 * checklists for one person means two sets of due dates and two people each
 * assuming the other is chasing it.
 */
export async function startJourney(params: {
  employeeId: number;
  direction: Direction;
  anchorDate: string;
  templateId?: number | null;
  by: number;
  ip?: string | null;
  notes?: string | null;
}): Promise<number> {
  const { employeeId, direction, anchorDate, by, ip = null, notes = null } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
    throw new OnboardingError('The date must be YYYY-MM-DD.');
  }

  const employee = await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE id = ?`, [employeeId]);
  if (!employee) throw new OnboardingError('No such employee.');

  const open = await queryOne<{ id: number }>(
    `SELECT id FROM employee_onboarding
      WHERE employee_id = ? AND direction = ? AND status = 'in_progress' LIMIT 1`,
    [employeeId, direction]);
  if (open) {
    throw new OnboardingError(
      `This person already has a ${direction} checklist in progress. `
      + 'Finish or cancel that one first, so there is only ever one list being chased.',
    );
  }

  const template = params.templateId
    ? (await listTemplates()).find(t => t.id === params.templateId) ?? null
    : await defaultTemplate(direction);

  const res = await query(
    `INSERT INTO employee_onboarding
       (employee_id, template_id, direction, anchor_date, started_by, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [employeeId, template?.id ?? null, direction, anchorDate, by, notes],
  ) as unknown as { insertId: number };
  const journeyId = res.insertId;

  // Copied, with their dates already resolved. A template edited next month
  // leaves this list exactly as it was handed over.
  //
  // One statement, not one per task. The standard checklist has sixteen
  // entries, so the obvious loop costs sixteen round trips every time
  // somebody joins - and they are all inserted or none, which a loop
  // cannot promise.
  const tasks = template?.tasks ?? [];
  if (tasks.length > 0) {
    const values: unknown[] = [];
    const rows = tasks.map(t => {
      values.push(journeyId, t.title, t.description, t.owner_role, t.category,
        addDays(anchorDate, t.due_offset_days), t.is_blocking, t.sort_order);
      return '(?, ?, ?, ?, ?, ?, ?, ?)';
    });
    await query(
      `INSERT INTO employee_onboarding_tasks
         (journey_id, title, description, owner_role, category, due_on,
          is_blocking, sort_order)
       VALUES ${rows.join(', ')}`,
      values,
    );
  }

  // Kept on the employee as well, because the rest of the app reads these
  // columns and a second disagreeing answer is how employees.department went
  // wrong.
  if (direction === 'onboarding') {
    await query(`UPDATE employees SET joined_on = COALESCE(joined_on, ?) WHERE id = ?`,
      [anchorDate, employeeId]);
  } else {
    await query(`UPDATE employees SET last_working_day = ? WHERE id = ?`,
      [anchorDate, employeeId]);
  }

  await insertAuditLog({
    action: direction === 'onboarding' ? 'onboarding_started' : 'offboarding_started',
    entity: 'employee_onboarding', entity_id: journeyId,
    performed_by: by, ip_address: ip,
    details: { employee_id: employeeId, direction, anchor_date: anchorDate,
               template: template?.name ?? null, tasks: template?.tasks.length ?? 0 },
  });
  return journeyId;
}

const JOURNEY_SELECT = `
  SELECT j.id, j.employee_id, e.name AS employee_name, e.emp_id, j.direction,
         DATE_FORMAT(j.anchor_date, '%Y-%m-%d') AS anchor_date, j.status,
         t.name AS template_name, j.notes
    FROM employee_onboarding j
    JOIN employees e ON e.id = j.employee_id
    LEFT JOIN onboarding_templates t ON t.id = j.template_id`;

export async function listJourneys(params: {
  direction?: Direction;
  status?: 'in_progress' | 'completed' | 'cancelled';
  employeeId?: number;
} = {}): Promise<Journey[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.direction) { where.push('j.direction = ?'); args.push(params.direction); }
  if (params.status) { where.push('j.status = ?'); args.push(params.status); }
  if (params.employeeId) { where.push('j.employee_id = ?'); args.push(params.employeeId); }

  const journeys = await query<Omit<Journey, 'tasks' | 'total' | 'done' | 'blocking_outstanding' | 'overdue'>>(
    `${JOURNEY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY j.status = 'in_progress' DESC, j.anchor_date DESC`,
    args,
  );
  if (journeys.length === 0) return [];

  const tasks = await query<
    Omit<JourneyTask, 'is_blocking' | 'overdue'> & { journey_id: number; is_blocking: number }
  >(
    `SELECT t.id, t.journey_id, t.title, t.description, t.owner_role, t.category,
            DATE_FORMAT(t.due_on, '%Y-%m-%d') AS due_on, t.is_blocking, t.status,
            t.completed_at, c.name AS completed_by_name, t.notes, t.sort_order
       FROM employee_onboarding_tasks t
       LEFT JOIN employees c ON c.id = t.completed_by
      WHERE t.journey_id IN (${journeys.map(() => '?').join(',')})
      ORDER BY t.sort_order, t.id`,
    journeys.map(j => j.id),
  );

  const now = today();
  return journeys.map(j => {
    const mine = tasks.filter(t => t.journey_id === j.id).map(t => ({
      ...t,
      is_blocking: Boolean(t.is_blocking),
      // Only pending tasks can be overdue. A task marked not-applicable is a
      // decision, not a thing left undone.
      overdue: t.status === 'pending' && Boolean(t.due_on) && t.due_on! < now,
    }));
    return {
      ...j,
      tasks: mine,
      total: mine.length,
      done: mine.filter(t => t.status !== 'pending').length,
      blocking_outstanding: mine.filter(t => t.status === 'pending' && t.is_blocking).length,
      overdue: mine.filter(t => t.overdue).length,
    };
  });
}

export async function setTaskStatus(params: {
  taskId: number;
  status: TaskStatus;
  by: number;
  notes?: string | null;
  ip?: string | null;
}): Promise<void> {
  const { taskId, status, by, notes, ip = null } = params;

  const task = await queryOne<{ journey_id: number; title: string; status: TaskStatus }>(
    `SELECT journey_id, title, status FROM employee_onboarding_tasks WHERE id = ?`, [taskId]);
  if (!task) throw new OnboardingError('No such task.');

  await query(
    `UPDATE employee_onboarding_tasks
        SET status = ?,
            completed_at = ${status === 'pending' ? 'NULL' : 'UTC_TIMESTAMP()'},
            completed_by = ${status === 'pending' ? 'NULL' : '?'}
            ${notes !== undefined ? ', notes = ?' : ''}
      WHERE id = ?`,
    status === 'pending'
      ? (notes !== undefined ? [status, notes, taskId] : [status, taskId])
      : (notes !== undefined ? [status, by, notes, taskId] : [status, by, taskId]),
  );

  await insertAuditLog({
    action: 'onboarding_task_updated', entity: 'employee_onboarding_task', entity_id: taskId,
    performed_by: by, ip_address: ip,
    details: { task: task.title, from: task.status, to: status },
  });
}

/**
 * Close a checklist.
 *
 * Refuses while a blocking task is still pending unless `force` is given, and
 * records the override when it is. "Access revoked" left pending on somebody
 * who has already gone is exactly the case this is here to catch — so it can
 * be overridden, because reality sometimes requires it, but never silently.
 */
export async function completeJourney(params: {
  journeyId: number;
  by: number;
  force?: boolean;
  ip?: string | null;
}): Promise<void> {
  const { journeyId, by, force = false, ip = null } = params;

  const journey = await queryOne<{ direction: Direction; employee_id: number; status: string }>(
    `SELECT direction, employee_id, status FROM employee_onboarding WHERE id = ?`, [journeyId]);
  if (!journey) throw new OnboardingError('No such checklist.');
  if (journey.status !== 'in_progress') throw new OnboardingError('That checklist is already closed.');

  const blocking = await query<{ title: string }>(
    `SELECT title FROM employee_onboarding_tasks
      WHERE journey_id = ? AND status = 'pending' AND is_blocking = TRUE
      ORDER BY sort_order`,
    [journeyId]);

  if (blocking.length > 0 && !force) {
    throw new OnboardingError(
      `${blocking.length} required task(s) are still open: `
      + `${blocking.slice(0, 3).map(b => b.title).join(', ')}`
      + `${blocking.length > 3 ? ', and more' : ''}. `
      + 'Close them, mark them not applicable, or confirm you want to finish anyway.',
    );
  }

  await query(
    `UPDATE employee_onboarding SET status = 'completed', completed_at = UTC_TIMESTAMP()
      WHERE id = ?`, [journeyId]);

  await insertAuditLog({
    action: journey.direction === 'onboarding' ? 'onboarding_completed' : 'offboarding_completed',
    entity: 'employee_onboarding', entity_id: journeyId,
    performed_by: by, ip_address: ip,
    details: {
      employee_id: journey.employee_id,
      forced: force && blocking.length > 0,
      skipped_blocking: force ? blocking.map(b => b.title) : [],
    },
  });
}

export async function cancelJourney(
  journeyId: number, by: number, ip?: string | null,
): Promise<void> {
  await query(
    `UPDATE employee_onboarding SET status = 'cancelled' WHERE id = ? AND status = 'in_progress'`,
    [journeyId]);
  await insertAuditLog({
    action: 'onboarding_cancelled', entity: 'employee_onboarding', entity_id: journeyId,
    performed_by: by, ip_address: ip ?? null, details: { journey_id: journeyId },
  });
}

/**
 * What needs chasing, across everybody.
 *
 * Deliberately narrow: overdue and blocking only. A queue that lists every
 * outstanding task is a queue nobody reads, and the ones that matter are then
 * indistinguishable from the ones that do not.
 */
export async function attentionQueue(): Promise<{
  overdue: Array<{ journey_id: number; employee_name: string; emp_id: string;
                   direction: Direction; title: string; due_on: string; owner_role: OwnerRole }>;
  starting_soon: Array<{ employee_name: string; emp_id: string; anchor_date: string; direction: Direction }>;
  probation_due: Array<{ id: number; name: string; emp_id: string; probation_ends_on: string }>;
  documents_expiring: Array<{ employee_name: string; title: string; expires_on: string }>;
}> {
  const now = today();
  const in30 = addDays(now, 30);

  const overdue = await query<{
    journey_id: number; employee_name: string; emp_id: string;
    direction: Direction; title: string; due_on: string; owner_role: OwnerRole;
  }>(
    `SELECT j.id AS journey_id, e.name AS employee_name, e.emp_id, j.direction,
            t.title, DATE_FORMAT(t.due_on, '%Y-%m-%d') AS due_on, t.owner_role
       FROM employee_onboarding_tasks t
       JOIN employee_onboarding j ON j.id = t.journey_id AND j.status = 'in_progress'
       JOIN employees e ON e.id = j.employee_id
      WHERE t.status = 'pending' AND t.due_on IS NOT NULL AND t.due_on < ?
      ORDER BY t.is_blocking DESC, t.due_on`,
    [now]);

  const startingSoon = await query<{
    employee_name: string; emp_id: string; anchor_date: string; direction: Direction;
  }>(
    `SELECT e.name AS employee_name, e.emp_id,
            DATE_FORMAT(j.anchor_date, '%Y-%m-%d') AS anchor_date, j.direction
       FROM employee_onboarding j JOIN employees e ON e.id = j.employee_id
      WHERE j.status = 'in_progress' AND j.anchor_date BETWEEN ? AND ?
      ORDER BY j.anchor_date`,
    [now, in30]);

  // Probation was already a number of months on the policy, and a number of
  // months cannot be reminded about. A date can.
  const probation = await query<{ id: number; name: string; emp_id: string; probation_ends_on: string }>(
    `SELECT id, name, emp_id, DATE_FORMAT(probation_ends_on, '%Y-%m-%d') AS probation_ends_on
       FROM employees
      WHERE is_active = TRUE AND probation_ends_on IS NOT NULL
        AND probation_ends_on BETWEEN ? AND ?
      ORDER BY probation_ends_on`,
    [now, in30]).catch(() => []);

  const documents = await query<{ employee_name: string; title: string; expires_on: string }>(
    `SELECT e.name AS employee_name, d.title,
            DATE_FORMAT(d.expires_on, '%Y-%m-%d') AS expires_on
       FROM employee_documents d JOIN employees e ON e.id = d.employee_id
      WHERE d.expires_on IS NOT NULL AND d.expires_on <= ? AND e.is_active = TRUE
      ORDER BY d.expires_on`,
    [in30]).catch(() => []);

  return { overdue, starting_soon: startingSoon, probation_due: probation, documents_expiring: documents };
}
