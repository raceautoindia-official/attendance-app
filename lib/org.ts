import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';

/**
 * lib/org.ts — the company, the department tree, grades, teams, and who is where.
 *
 * Four ideas, deliberately kept apart:
 *
 *   COMPANY     a corporate profile. Several are allowed: group structures and
 *               subsidiaries are normal, and a settings blob could not hold two.
 *   DEPARTMENT  a tree. "L2" is not a type of thing, it is a department whose
 *               parent is an L1, so the structure nests as deep as needed
 *               without a new concept per level.
 *   GRADE       seniority, carried by the PERSON. Separate from the department
 *               on purpose: a grade travels with somebody when they move, and a
 *               department keeps its shape when somebody is promoted. Folded
 *               together, a promotion would look like a transfer and "who is in
 *               Operations" would change every time somebody was promoted.
 *   ASSIGNMENT  who is in which department and team, at what grade, reporting to
 *               whom, FROM WHEN. Dated like employee_schedules and
 *               employee_policies, for the same reason: a reorganisation in
 *               March must not rewrite what January's reports said.
 *
 * Two cycle checks live here and are not optional. A department that is its own
 * ancestor, or a reporting line that loops, makes "everything below this node"
 * recurse until the process dies — and both are reachable with two ordinary
 * edits by somebody who meant no harm.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Company {
  id: number;
  legal_name: string;
  trading_name: string | null;
  registration_no: string | null;
  pan: string | null;
  tan: string | null;
  gstin: string | null;
  pf_code: string | null;
  esi_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_code: string | null;
  country_code: string;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  /** The work site that is the registered office, when one is chosen. */
  registered_location_id: number | null;
  registered_location_name: string | null;
  fy_start_month: number;
  timezone: string;
  is_active: boolean;
}

export interface Department {
  id: number;
  company_id: number | null;
  parent_id: number | null;
  name: string;
  code: string;
  description: string | null;
  head_employee_id: number | null;
  head_name: string | null;
  depth: number;
  sort_order: number;
  is_active: boolean;
  /** Live counts, so the tree can be read without a second request per node. */
  employee_count: number;
  team_count: number;
}

export interface DepartmentNode extends Department {
  children: DepartmentNode[];
}

export interface Grade {
  id: number;
  code: string;
  name: string;
  rank_order: number;
  description: string | null;
  is_active: boolean;
  employee_count: number;
}

export interface Team {
  id: number;
  department_id: number;
  department_name: string | null;
  name: string;
  code: string;
  lead_employee_id: number | null;
  lead_name: string | null;
  description: string | null;
  is_active: boolean;
  employee_count: number;
}

export interface OrgAssignment {
  id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  department_id: number | null;
  department_name: string | null;
  team_id: number | null;
  team_name: string | null;
  grade_id: number | null;
  grade_code: string | null;
  reports_to_employee_id: number | null;
  reports_to_name: string | null;
  designation: string | null;
  effective_from: string;
  effective_to: string | null;
}

/** Raised for a rule the caller can fix, as opposed to a bug. */
export class OrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgError';
  }
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

/**
 * The companies, each with the NAME of its registered site.
 *
 * Joined rather than stored: the site can be renamed, and a copy of its name
 * on the company row would be the kind of stale second fact this link exists
 * to remove.
 */
/**
 * mysql2 hands back TINYINT(1) as the NUMBER 1 or 0, so a row typed `Company`
 * arrives claiming a boolean it does not have. Nothing notices until the row
 * goes back to the API - an edit form sends what it was given - and the schema
 * refuses it with 'is_active: expected boolean, received number'. Which is
 * exactly what happened: every company edit failed.
 *
 * Departments, teams and grades already cast here. Companies did not.
 */
const asCompany = (r: Company): Company => ({ ...r, is_active: Boolean(r.is_active) });

export async function listCompanies(includeInactive = false): Promise<Company[]> {
  const rows = await query<Company>(
    `SELECT c.*, l.name AS registered_location_name
       FROM companies c
       LEFT JOIN locations l ON l.id = c.registered_location_id
      ${includeInactive ? '' : 'WHERE c.is_active = TRUE'}
      ORDER BY c.legal_name`,
  );
  return rows.map(asCompany);
}

export async function getCompany(id: number): Promise<Company | null> {
  const row = await queryOne<Company>(
    `SELECT c.*, l.name AS registered_location_name
       FROM companies c
       LEFT JOIN locations l ON l.id = c.registered_location_id
      WHERE c.id = ?`, [id]);
  return row ? asCompany(row) : null;
}

/**
 * The chain, counted: company -> work sites -> departments -> people.
 *
 * WHY THIS IS ONE QUERY AND NOT A PAGE OF THEM
 * -------------------------------------------
 * Every link in it already existed in the schema and NONE of it was visible,
 * so nobody could tell whether it was connected. Six work sites belonged to no
 * company, three departments belonged to no company, and seventeen people were
 * rostered to a site while one was placed in a department - all of which looked
 * fine on every screen.
 *
 * People are counted BOTH ways on purpose. Through the department is the org
 * chart; through the work site is the roster. When the two disagree, something
 * is wrong - and the gap is the point of showing both.
 */
export async function companyChain() {
  return query<{
    company_id: number; legal_name: string;
    sites: number; departments: number;
    people_by_department: number; people_by_site: number;
  }>(
    `SELECT c.id AS company_id, c.legal_name,
            (SELECT COUNT(*) FROM locations l
              WHERE l.company_id = c.id AND l.is_active = TRUE) AS sites,
            (SELECT COUNT(*) FROM departments d
              WHERE d.company_id = c.id AND d.is_active = TRUE) AS departments,
            (SELECT COUNT(DISTINCT a.employee_id)
               FROM employee_org_assignments a
               JOIN departments d2 ON d2.id = a.department_id
               JOIN employees e ON e.id = a.employee_id AND e.is_active = TRUE
              WHERE d2.company_id = c.id
                AND a.effective_from <= CURDATE()
                AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())
            ) AS people_by_department,
            (SELECT COUNT(DISTINCT es.employee_id)
               FROM employee_schedules es
               JOIN locations l2 ON l2.id = es.location_id
               JOIN employees e2 ON e2.id = es.employee_id AND e2.is_active = TRUE
              WHERE l2.company_id = c.id
                AND es.effective_from <= CURDATE()
                AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
            ) AS people_by_site
       FROM companies c
      WHERE c.is_active = TRUE
      ORDER BY c.legal_name`,
  );
}

/**
 * What is not attached to anything, which is the useful half.
 *
 * A screen that only shows what IS connected cannot tell you what is missing,
 * and missing is the normal state of a chain nobody has been able to see.
 */
export async function chainGaps() {
  const [sites, departments, people] = await Promise.all([
    query<{ id: number; name: string }>(
      `SELECT id, name FROM locations WHERE is_active = TRUE AND company_id IS NULL
        ORDER BY name`),
    query<{ id: number; name: string }>(
      `SELECT id, name FROM departments WHERE is_active = TRUE AND company_id IS NULL
        ORDER BY name`),
    // Somebody rostered to a site whose company is not the company of the
    // department they are placed in. Both facts are deliberate acts, so this
    // is a disagreement rather than a gap - and it is the one that quietly
    // breaks a report.
    query<{ id: number; name: string; emp_id: string; site: string; department: string }>(
      `SELECT DISTINCT e.id, e.name, e.emp_id, l.name AS site, d.name AS department
         FROM employees e
         JOIN employee_schedules es ON es.employee_id = e.id
          AND es.effective_from <= CURDATE()
          AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
         JOIN locations l ON l.id = es.location_id
         JOIN employee_org_assignments a ON a.employee_id = e.id
          AND a.effective_from <= CURDATE()
          AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())
         JOIN departments d ON d.id = a.department_id
        WHERE e.is_active = TRUE
          AND l.company_id IS NOT NULL AND d.company_id IS NOT NULL
          AND l.company_id <> d.company_id
        ORDER BY e.name`),
  ]);
  return { sites_without_company: sites, departments_without_company: departments, people_in_two_companies: people };
}

/**
 * Attach work sites and departments to a company, and detach what was removed.
 *
 * WHY THIS EXISTS AS ONE CALL
 * ---------------------------
 * The links were settable in two places that had nothing to do with the
 * company: a site's own form and a department's own drawer. So after creating
 * a company you were told it had no sites and no departments, and the only way
 * to fix that was to leave, open each site, set a dropdown, come back, open
 * each department, set another dropdown, and come back again. Nobody does
 * that, which is why five sites and three departments belonged to nothing.
 *
 * Passing a list REPLACES the set for that company: anything in the list is
 * attached, anything currently attached and absent from the list is detached.
 * Passing undefined leaves that side alone, so the two can be edited
 * separately.
 *
 * Detaching sets NULL rather than deleting: a site that stops belonging to a
 * company is still a site people clock in at.
 */
export async function setCompanyLinks(params: {
  companyId: number;
  locationIds?: number[];
  departmentIds?: number[];
  by: number;
  ip?: string | null;
}): Promise<{ sites: number; departments: number }> {
  const company = await queryOne<{ id: number }>(
    `SELECT id FROM companies WHERE id = ?`, [params.companyId]);
  if (!company) throw new OrgError('No such company.');

  if (params.locationIds !== undefined) {
    const ids = params.locationIds;
    // Detach first, then attach: doing it the other way round would briefly
    // leave a site on two companies, and the detach would then undo the attach.
    await query(
      `UPDATE locations SET company_id = NULL
        WHERE company_id = ?
          ${ids.length > 0 ? `AND id NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
      [params.companyId, ...ids],
    );
    if (ids.length > 0) {
      await query(
        `UPDATE locations SET company_id = ?
          WHERE id IN (${ids.map(() => '?').join(',')})`,
        [params.companyId, ...ids],
      );
    }
  }

  if (params.departmentIds !== undefined) {
    const ids = params.departmentIds;
    await query(
      `UPDATE departments SET company_id = NULL
        WHERE company_id = ?
          ${ids.length > 0 ? `AND id NOT IN (${ids.map(() => '?').join(',')})` : ''}`,
      [params.companyId, ...ids],
    );
    if (ids.length > 0) {
      await query(
        `UPDATE departments SET company_id = ?
          WHERE id IN (${ids.map(() => '?').join(',')})`,
        [params.companyId, ...ids],
      );
    }
  }

  const counts = await queryOne<{ sites: number; departments: number }>(
    `SELECT (SELECT COUNT(*) FROM locations WHERE company_id = ? AND is_active = TRUE) AS sites,
            (SELECT COUNT(*) FROM departments WHERE company_id = ? AND is_active = TRUE) AS departments`,
    [params.companyId, params.companyId],
  );

  await insertAuditLog({
    action: 'company_links_set',
    entity: 'company',
    entity_id: params.companyId,
    performed_by: params.by,
    details: {
      locations: params.locationIds ?? null,
      departments: params.departmentIds ?? null,
      sites_now: Number(counts?.sites ?? 0),
      departments_now: Number(counts?.departments ?? 0),
    },
    ip_address: params.ip ?? null,
  });

  return { sites: Number(counts?.sites ?? 0), departments: Number(counts?.departments ?? 0) };
}

/** Every department, with whichever company currently owns it. */
export async function departmentsForLinking() {
  return query<{ id: number; name: string; code: string; company_id: number | null; depth: number }>(
    `SELECT id, name, code, company_id, depth FROM departments
      WHERE is_active = TRUE ORDER BY depth, name`,
  );
}

/** The work sites belonging to a company, and the ones belonging to nobody. */
export async function companyLocations(companyId?: number) {
  return query<{
    id: number; name: string; company_id: number | null; address: string | null;
    city: string | null; state_code: string | null; country_code: string | null;
    latitude: string; longitude: string; radius_meters: number; is_active: number;
  }>(
    `SELECT id, name, company_id, address, city, state_code, country_code,
            latitude, longitude, radius_meters, is_active
       FROM locations
      WHERE is_active = TRUE
        ${companyId ? 'AND (company_id = ? OR company_id IS NULL)' : ''}
      ORDER BY company_id IS NULL, name`,
    companyId ? [companyId] : [],
  );
}

const COMPANY_FIELDS = [
  'legal_name', 'trading_name', 'registration_no', 'pan', 'tan', 'gstin',
  'pf_code', 'esi_code', 'address_line1', 'address_line2', 'city',
  'state_code', 'country_code', 'postal_code', 'phone', 'email', 'website',
  'logo_url', 'registered_location_id', 'fy_start_month', 'timezone', 'is_active',
] as const;

export async function saveCompany(
  input: Partial<Company> & { legal_name: string },
  by: number,
  ip?: string | null,
): Promise<Company> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const f of COMPANY_FIELDS) {
    if (input[f] !== undefined) { cols.push(f); vals.push(input[f]); }
  }

  if (input.id) {
    if (cols.length === 0) throw new OrgError('Nothing to change.');
    await query(
      `UPDATE companies SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...vals, input.id],
    );
    await insertAuditLog({
      action: 'company_updated', entity: 'company', entity_id: input.id,
      performed_by: by, ip_address: ip ?? null, details: { fields: cols },
    });
    return (await getCompany(input.id))!;
  }

  const res = await query(
    `INSERT INTO companies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals,
  ) as unknown as { insertId: number };
  await insertAuditLog({
    action: 'company_created', entity: 'company', entity_id: res.insertId,
    performed_by: by, ip_address: ip ?? null, details: { legal_name: input.legal_name },
  });
  return (await getCompany(res.insertId))!;
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

const DEPARTMENT_SELECT = `
  SELECT d.*, h.name AS head_name,
         (SELECT COUNT(DISTINCT a.employee_id) FROM employee_org_assignments a
           WHERE a.department_id = d.id AND a.effective_to IS NULL) AS employee_count,
         (SELECT COUNT(*) FROM teams t
           WHERE t.department_id = d.id AND t.is_active = TRUE) AS team_count
    FROM departments d
    LEFT JOIN employees h ON h.id = d.head_employee_id`;

export async function listDepartments(includeInactive = false): Promise<Department[]> {
  const rows = await query<Department>(
    `${DEPARTMENT_SELECT} ${includeInactive ? '' : 'WHERE d.is_active = TRUE'}
      ORDER BY d.depth, d.sort_order, d.name`,
  );
  return rows.map(r => ({
    ...r,
    is_active: Boolean(r.is_active),
    employee_count: Number(r.employee_count),
    team_count: Number(r.team_count),
  }));
}

/** The same departments, nested. Built in one pass over a flat list. */
export function buildDepartmentTree(rows: Department[]): DepartmentNode[] {
  const byId = new Map<number, DepartmentNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });

  const roots: DepartmentNode[] = [];
  for (const node of byId.values()) {
    // A child whose parent is inactive (and so filtered out) would otherwise
    // vanish from the tree entirely. Surfacing it at the top is wrong in
    // principle and right in practice: it is visible, and therefore fixable.
    const parent = node.parent_id === null ? null : byId.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: DepartmentNode[]) => {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/**
 * Every department at or below `rootId`, as ids.
 *
 * This is what a `department` permission scope resolves to, so it is also the
 * function a reporting cycle would hang. It walks iteratively with a seen-set
 * rather than recursing, so even if the data is somehow cyclic this terminates
 * and returns something sane instead of exhausting the stack.
 */
export async function departmentSubtreeIds(rootId: number): Promise<number[]> {
  return departmentSubtreeIdsFor([rootId]);
}

/**
 * The same walk, for several roots at once, from ONE read of the tree.
 *
 * The permission layer resolves a department scope on every request a scoped
 * user makes, and somebody can head more than one department. Calling the
 * single-root version in a loop re-read the whole departments table once per
 * root, on the hot path.
 */
export async function departmentSubtreeIdsFor(rootIds: number[]): Promise<number[]> {
  if (rootIds.length === 0) return [];
  const all = await query<{ id: number; parent_id: number | null }>(
    `SELECT id, parent_id FROM departments`,
  );
  const childrenOf = new Map<number, number[]>();
  for (const r of all) {
    if (r.parent_id === null) continue;
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r.id);
    childrenOf.set(r.parent_id, list);
  }

  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}

/** True when making `parentId` the parent of `id` would create a loop. */
async function wouldCycle(id: number, parentId: number | null): Promise<boolean> {
  if (parentId === null) return false;
  if (parentId === id) return true;
  const all = await query<{ id: number; parent_id: number | null }>(
    `SELECT id, parent_id FROM departments`,
  );
  const parentOf = new Map(all.map(r => [r.id, r.parent_id]));

  // Walk upward from the proposed parent. Reaching `id` means `id` is already
  // an ancestor, so attaching it below would close the loop.
  let cursor: number | null = parentId;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (cursor === id) return true;
    if (seen.has(cursor)) return true; // already cyclic; refuse to add to it
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}

async function depthOf(parentId: number | null): Promise<number> {
  if (parentId === null) return 0;
  const parent = await queryOne<{ depth: number }>(
    `SELECT depth FROM departments WHERE id = ?`, [parentId],
  );
  if (!parent) throw new OrgError('That parent department does not exist.');
  return Number(parent.depth) + 1;
}

export async function saveDepartment(
  input: {
    id?: number; name: string; code: string; parent_id?: number | null;
    description?: string | null; head_employee_id?: number | null;
    sort_order?: number; is_active?: boolean; company_id?: number | null;
  },
  by: number,
  ip?: string | null,
): Promise<Department> {
  const parentId = input.parent_id ?? null;

  if (input.id && await wouldCycle(input.id, parentId)) {
    throw new OrgError(
      'That would put the department inside itself. A department cannot report '
      + 'to one of its own sub-departments.',
    );
  }

  const depth = await depthOf(parentId);

  if (input.id) {
    await query(
      `UPDATE departments
          SET name = ?, code = ?, parent_id = ?, description = ?,
              head_employee_id = ?, sort_order = ?, is_active = ?, depth = ?
        WHERE id = ?`,
      [input.name, input.code, parentId, input.description ?? null,
       input.head_employee_id ?? null, input.sort_order ?? 0,
       input.is_active ?? true, depth, input.id],
    );
    // Moving a node moves everything under it, so their stored depth is now
    // wrong. Recomputed here rather than on read, because every list query
    // needs depth and recursing per row per render is the expensive way round.
    await recomputeDepths();
    await insertAuditLog({
      action: 'department_updated', entity: 'department', entity_id: input.id,
      performed_by: by, ip_address: ip ?? null,
      details: { name: input.name, parent_id: parentId },
    });
    return (await getDepartment(input.id))!;
  }

  const res = await query(
    `INSERT INTO departments (company_id, parent_id, name, code, description,
                              head_employee_id, depth, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.company_id ?? null, parentId, input.name, input.code,
     input.description ?? null, input.head_employee_id ?? null, depth,
     input.sort_order ?? 0, input.is_active ?? true],
  ) as unknown as { insertId: number };
  await insertAuditLog({
    action: 'department_created', entity: 'department', entity_id: res.insertId,
    performed_by: by, ip_address: ip ?? null,
    details: { name: input.name, code: input.code, parent_id: parentId },
  });
  return (await getDepartment(res.insertId))!;
}

export async function getDepartment(id: number): Promise<Department | null> {
  const rows = await query<Department>(`${DEPARTMENT_SELECT} WHERE d.id = ?`, [id]);
  const r = rows[0];
  return r ? { ...r, is_active: Boolean(r.is_active),
               employee_count: Number(r.employee_count),
               team_count: Number(r.team_count) } : null;
}

/** Rewrite every stored depth from the parent links. Cheap; runs after a move. */
async function recomputeDepths(): Promise<void> {
  const all = await query<{ id: number; parent_id: number | null }>(
    `SELECT id, parent_id FROM departments`,
  );
  const parentOf = new Map(all.map(r => [r.id, r.parent_id]));

  // The depth of every node is worked out in memory first, then written
  // in ONE statement. This runs after every department save, so the
  // obvious loop costs one round trip per department each time somebody
  // renames one - and it is also the only moment the tree is half
  // re-levelled, which a single statement avoids entirely.
  const next: Array<{ id: number; depth: number }> = [];
  for (const row of all) {
    let depth = 0;
    let cursor = parentOf.get(row.id) ?? null;
    const seen = new Set<number>([row.id]);
    // The guard is not decoration: saveDepartment refuses to create a
    // cycle, but data predating that check would loop here forever.
    while (cursor !== null && !seen.has(cursor) && depth < 50) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    next.push({ id: row.id, depth });
  }
  if (next.length === 0) return;

  const params: number[] = [];
  const cases = next.map(n => { params.push(n.id, n.depth); return 'WHEN ? THEN ?'; });
  const ids = next.map(n => { params.push(n.id); return '?'; });
  await query(
    `UPDATE departments SET depth = CASE id ${cases.join(' ')} END
      WHERE id IN (${ids.join(',')})`,
    params,
  );
}

export async function deactivateDepartment(id: number, by: number, ip?: string | null): Promise<void> {
  const children = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM departments WHERE parent_id = ? AND is_active = TRUE`, [id],
  );
  if (Number(children?.n ?? 0) > 0) {
    throw new OrgError(
      'This department still has sub-departments. Move or close those first, '
      + 'so nobody is left in a department that is no longer there.',
    );
  }
  const staff = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT employee_id) AS n FROM employee_org_assignments
      WHERE department_id = ? AND effective_to IS NULL`, [id],
  );
  if (Number(staff?.n ?? 0) > 0) {
    throw new OrgError(
      `${staff?.n} employee(s) are still in this department. Move them first — `
      + 'closing it would leave them unplaced and invisible to department-scoped access.',
    );
  }
  await query(`UPDATE departments SET is_active = FALSE WHERE id = ?`, [id]);
  await insertAuditLog({
    action: 'department_deactivated', entity: 'department', entity_id: id,
    performed_by: by, ip_address: ip ?? null, details: { department_id: id },
  });
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export async function listGrades(includeInactive = false): Promise<Grade[]> {
  const rows = await query<Grade>(
    `SELECT g.*,
            (SELECT COUNT(DISTINCT a.employee_id) FROM employee_org_assignments a
              WHERE a.grade_id = g.id AND a.effective_to IS NULL) AS employee_count
       FROM grades g
      ${includeInactive ? '' : 'WHERE g.is_active = TRUE'}
      ORDER BY g.rank_order, g.code`,
  );
  return rows.map(r => ({ ...r, is_active: Boolean(r.is_active), employee_count: Number(r.employee_count) }));
}

export async function saveGrade(
  input: { id?: number; code: string; name: string; rank_order?: number;
           description?: string | null; is_active?: boolean },
  by: number, ip?: string | null,
): Promise<void> {
  if (input.id) {
    await query(
      `UPDATE grades SET code = ?, name = ?, rank_order = ?, description = ?, is_active = ?
        WHERE id = ?`,
      [input.code, input.name, input.rank_order ?? 0, input.description ?? null,
       input.is_active ?? true, input.id],
    );
  } else {
    await query(
      `INSERT INTO grades (code, name, rank_order, description, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [input.code, input.name, input.rank_order ?? 0, input.description ?? null,
       input.is_active ?? true],
    );
  }
  await insertAuditLog({
    action: input.id ? 'grade_updated' : 'grade_created', entity: 'grade',
    entity_id: input.id ?? 0, performed_by: by, ip_address: ip ?? null,
    details: { code: input.code, name: input.name },
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export async function listTeams(params: { departmentId?: number; includeInactive?: boolean } = {}): Promise<Team[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!params.includeInactive) where.push('t.is_active = TRUE');
  if (params.departmentId) { where.push('t.department_id = ?'); args.push(params.departmentId); }

  const rows = await query<Team>(
    `SELECT t.*, d.name AS department_name, l.name AS lead_name,
            (SELECT COUNT(DISTINCT a.employee_id) FROM employee_org_assignments a
              WHERE a.team_id = t.id AND a.effective_to IS NULL) AS employee_count
       FROM teams t
       JOIN departments d ON d.id = t.department_id
       LEFT JOIN employees l ON l.id = t.lead_employee_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.name, t.name`,
    args,
  );
  return rows.map(r => ({ ...r, is_active: Boolean(r.is_active), employee_count: Number(r.employee_count) }));
}

export async function saveTeam(
  input: { id?: number; department_id: number; name: string; code: string;
           lead_employee_id?: number | null; description?: string | null; is_active?: boolean },
  by: number, ip?: string | null,
): Promise<void> {
  if (input.id) {
    await query(
      `UPDATE teams SET department_id = ?, name = ?, code = ?, lead_employee_id = ?,
                        description = ?, is_active = ?
        WHERE id = ?`,
      [input.department_id, input.name, input.code, input.lead_employee_id ?? null,
       input.description ?? null, input.is_active ?? true, input.id],
    );
  } else {
    await query(
      `INSERT INTO teams (department_id, name, code, lead_employee_id, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.department_id, input.name, input.code, input.lead_employee_id ?? null,
       input.description ?? null, input.is_active ?? true],
    );
  }
  await insertAuditLog({
    action: input.id ? 'team_updated' : 'team_created', entity: 'team',
    entity_id: input.id ?? 0, performed_by: by, ip_address: ip ?? null,
    details: { name: input.name, department_id: input.department_id },
  });
}

// ---------------------------------------------------------------------------
// Assignments — who is where, since when
// ---------------------------------------------------------------------------

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.employee_id, e.name AS employee_name, e.emp_id,
         a.department_id, d.name AS department_name,
         a.team_id, t.name AS team_name,
         a.grade_id, g.code AS grade_code,
         a.reports_to_employee_id, m.name AS reports_to_name,
         a.designation,
         DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from,
         DATE_FORMAT(a.effective_to, '%Y-%m-%d') AS effective_to
    FROM employee_org_assignments a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN teams t ON t.id = a.team_id
    LEFT JOIN grades g ON g.id = a.grade_id
    LEFT JOIN employees m ON m.id = a.reports_to_employee_id`;

/** Current placements. `onDate` answers "where were they in March". */
export async function listAssignments(params: { employeeId?: number; onDate?: string } = {}): Promise<OrgAssignment[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.employeeId) { where.push('a.employee_id = ?'); args.push(params.employeeId); }
  if (params.onDate) {
    where.push('a.effective_from <= ? AND (a.effective_to IS NULL OR a.effective_to >= ?)');
    args.push(params.onDate, params.onDate);
  } else if (!params.employeeId) {
    where.push('a.effective_to IS NULL');
  }
  return query<OrgAssignment>(
    `${ASSIGNMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.name, a.effective_from DESC`,
    args,
  );
}

/** True when `managerId` already reports, directly or not, to `employeeId`. */
async function reportingWouldCycle(employeeId: number, managerId: number | null): Promise<boolean> {
  if (managerId === null) return false;
  if (managerId === employeeId) return true;

  const rows = await query<{ employee_id: number; reports_to_employee_id: number | null }>(
    `SELECT employee_id, reports_to_employee_id FROM employee_org_assignments
      WHERE effective_to IS NULL`,
  );
  const managerOf = new Map(rows.map(r => [r.employee_id, r.reports_to_employee_id]));

  let cursor: number | null = managerId;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (cursor === employeeId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = managerOf.get(cursor) ?? null;
  }
  return false;
}

/**
 * Place an employee, from a date.
 *
 * Mirrors assignPolicy: the open assignment is closed the day before this one
 * starts, and any assignment that would have begun on or after it is removed
 * rather than closed — closing it would set effective_to before effective_from,
 * which is the inverted range check-status already reports as a data fault.
 */
export async function assignToOrg(params: {
  employeeId: number;
  departmentId?: number | null;
  teamId?: number | null;
  gradeId?: number | null;
  reportsTo?: number | null;
  designation?: string | null;
  effectiveFrom: string;
  by: number;
  ip?: string | null;
  notes?: string | null;
}): Promise<void> {
  const { employeeId, effectiveFrom, by, ip = null, notes = null } = params;

  // UNDEFINED MEANS KEEP; NULL MEANS CLEAR.
  //
  // Moving somebody between departments should not silently delete their
  // manager and their grade, which is what treating every omitted field as
  // 'clear' did. A caller that genuinely wants to remove a reporting line
  // passes null for it and says so.
  const currentRow = await queryOne<{
    department_id: number | null; team_id: number | null; grade_id: number | null;
    reports_to_employee_id: number | null; designation: string | null;
  }>(
    `SELECT department_id, team_id, grade_id, reports_to_employee_id, designation
       FROM employee_org_assignments
      WHERE employee_id = ? AND effective_to IS NULL
      ORDER BY effective_from DESC LIMIT 1`,
    [employeeId],
  );

  const departmentId = params.departmentId !== undefined
    ? params.departmentId : currentRow?.department_id ?? null;
  const gradeId = params.gradeId !== undefined
    ? params.gradeId : currentRow?.grade_id ?? null;
  const reportsTo = params.reportsTo !== undefined
    ? params.reportsTo : currentRow?.reports_to_employee_id ?? null;
  const designation = params.designation !== undefined
    ? params.designation : currentRow?.designation ?? null;

  // The team is the exception. A team belongs to one department, so carrying
  // it across a department change would produce exactly the mismatch the
  // check below refuses. Changing department without naming a team therefore
  // clears it rather than failing.
  const departmentChanged = params.departmentId !== undefined
    && params.departmentId !== (currentRow?.department_id ?? null);
  const teamId = params.teamId !== undefined
    ? params.teamId
    : (departmentChanged ? null : currentRow?.team_id ?? null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw new OrgError('effective_from must be YYYY-MM-DD.');
  }
  if (await reportingWouldCycle(employeeId, reportsTo)) {
    throw new OrgError(
      'That reporting line loops back on itself. Somebody cannot report, '
      + 'directly or through others, to a person who reports to them.',
    );
  }
  if (teamId !== null && departmentId !== null) {
    const team = await queryOne<{ department_id: number }>(
      `SELECT department_id FROM teams WHERE id = ?`, [teamId],
    );
    if (team && Number(team.department_id) !== departmentId) {
      throw new OrgError('That team belongs to a different department.');
    }
  }

  const dayBefore = toYmd(new Date(Date.parse(`${effectiveFrom}T00:00:00Z`) - 86_400_000));

  await query(
    `UPDATE employee_org_assignments SET effective_to = ?
      WHERE employee_id = ? AND (effective_to IS NULL OR effective_to >= ?)
        AND effective_from < ?`,
    [dayBefore, employeeId, effectiveFrom, effectiveFrom],
  );
  await query(
    `DELETE FROM employee_org_assignments WHERE employee_id = ? AND effective_from >= ?`,
    [employeeId, effectiveFrom],
  );
  await query(
    `INSERT INTO employee_org_assignments
       (employee_id, department_id, team_id, grade_id, reports_to_employee_id,
        designation, effective_from, assigned_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, departmentId, teamId, gradeId, reportsTo, designation,
     effectiveFrom, by, notes],
  );

  // employees.manager_id is what the rest of the app already reads. Kept in
  // step so the org structure is not a second, disagreeing answer to "who is
  // their manager" — which is exactly the trap employees.department fell into.
  if (reportsTo !== null) {
    await query(`UPDATE employees SET manager_id = ? WHERE id = ?`, [reportsTo, employeeId]);
  }

  await insertAuditLog({
    action: 'org_assigned', entity: 'employee_org_assignment', entity_id: employeeId,
    performed_by: by, ip_address: ip,
    details: { employee_id: employeeId, department_id: departmentId, team_id: teamId,
               grade_id: gradeId, reports_to: reportsTo, effective_from: effectiveFrom },
  });
}

/** Active employees with no current placement — the queue that needs clearing. */
export async function unplacedEmployees(): Promise<Array<{ id: number; name: string; emp_id: string; legacy_department: string | null }>> {
  return query(
    `SELECT e.id, e.name, e.emp_id, NULLIF(e.department, '') AS legacy_department
       FROM employees e
      WHERE e.is_active = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM employee_org_assignments a
           WHERE a.employee_id = e.id AND a.effective_to IS NULL)
      ORDER BY e.name`,
  );
}
