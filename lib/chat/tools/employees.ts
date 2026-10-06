/**
 * lib/chat/tools/employees.ts — employee lookup for the admin chat.
 *
 * `resolveEmployee` is the entry point for any question naming a person. It
 * deliberately returns ALL candidates rather than guessing, so the model asks
 * which one instead of silently reporting on the wrong Arun.
 */

import { query } from '@/lib/db';
import {
  requireSuperAdmin,
  safeEmployeeSelect,
  type ChatContext,
  type ToolResult,
} from '../types';

/**
 * Escape LIKE wildcards so a search for "50%" or "a_b" matches literally
 * instead of behaving as a pattern. Backslash is MySQL's default LIKE escape
 * character, so prefixing with one is all that is needed — and the backslash
 * itself must be escaped first, hence its presence in the character class.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, ch => '\\' + ch);
}

export interface EmployeeCandidate {
  id: number;
  emp_id: string;
  name: string;
  department: string | null;
  role: string;
  is_active: 0 | 1;
  work_mode: 'on_site' | 'off_site';
  display: string;
  /** True when this came from the fuzzy pass — a guess, not a match. */
  suggestion?: boolean;
}

// ---------------------------------------------------------------------------
// Fuzzy fallback
//
// An exact LIKE match is all-or-nothing: "Reeena" finds nobody, and the honest
// answer "no employee matches" reads as the assistant being useless when the
// person is plainly there. With eighteen employees the whole list fits in
// memory, so a typo can be ranked rather than refused.
// ---------------------------------------------------------------------------

/** Standard Levenshtein distance, two-row variant. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Crude phonetic key, for transliterated names.
 *
 * Indian names reach this app spelled several ways — Reena/Rina,
 * Shankar/Sankar, Krishna/Krisna. Dropping non-initial vowels and collapsing
 * doubled letters makes those collide, which plain edit distance alone does
 * not do reliably.
 */
function phonetic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/(.)\1+/g, '$1')
    .replace(/(?!^)[aeiou]/g, '');
}

/** 0 = no resemblance, 1 = identical. */
function similarity(needle: string, hay: string): number {
  const a = needle.toLowerCase().trim();
  const b = hay.toLowerCase().trim();
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;

  const score = (x: string, y: string) =>
    1 - editDistance(x, y) / Math.max(x.length, y.length);

  // Against the whole name, against each word of it, and phonetically. A
  // surname typo should still find someone matched on their first name.
  let best = score(a, b);
  for (const word of b.split(/\s+/)) {
    if (word) best = Math.max(best, score(a, word));
  }
  // Phonetic comparison, but ONLY between names starting with the same letter.
  //
  // Dropping non-initial vowels collapses short names hard: "Reena" and "Arun"
  // both reduce to "rn", so a search for "Reeena" was offering Arun Pandian as
  // a candidate. Requiring the initial to agree keeps the useful collisions
  // (Reena/Rina, Sankar/Shankar) and drops the absurd ones.
  const pa = phonetic(a);
  if (pa) {
    for (const word of [b, ...b.split(/\s+/)]) {
      if (!word || word[0]?.toLowerCase() !== a[0]) continue;
      const pw = phonetic(word);
      if (pw) best = Math.max(best, score(pa, pw) * 0.95); // behind a real match
    }
  }
  return best;
}

/**
 * Below this, a "did you mean" is noise rather than help.
 *
 * Tuned against the real roster: genuine typos — Reeena/Reena, Krisna/Krishna,
 * Nalni/Nalini, Arn/Arun, Derrin/Derin — all score 0.75 or better, while the
 * coincidental near-misses that were cluttering the list (Rina→Krishna Mohan,
 * Sankar→Venkat Manohar) sit around 0.57. A list of three names when only one
 * is plausible makes the assistant look like it is guessing.
 */
const SUGGESTION_THRESHOLD = 0.62;

/**
 * Find employees matching a name fragment or an exact employee ID.
 *
 * Inactive employees are included (historical reports are a legitimate
 * question) but flagged, so the answer can say so.
 */
export async function resolveEmployee(
  ctx: ChatContext,
  args: { search: string; include_inactive?: boolean },
): Promise<ToolResult<EmployeeCandidate>> {
  requireSuperAdmin(ctx);

  const search = (args.search ?? '').trim();
  if (search.length < 2) {
    throw new Error('Provide at least 2 characters to search for an employee.');
  }

  // Backslash is MySQL's default LIKE escape character, so no ESCAPE clause
  // is needed — escapeLike() below prefixes wildcards with it.
  const conditions = ['(e.emp_id = ? OR e.name LIKE ?)'];
  const params: unknown[] = [search, `%${escapeLike(search)}%`];

  if (!args.include_inactive) {
    conditions.push('e.is_active = TRUE');
  }

  const rows = await query<Omit<EmployeeCandidate, 'display'>>(
    `SELECT e.id, e.emp_id, e.name, e.department, e.role, e.is_active, e.work_mode
       FROM employees e
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.is_active DESC, e.name ASC
      LIMIT 25`,
    params,
  );

  const display = (r: Omit<EmployeeCandidate, 'display' | 'suggestion'>) =>
    `${r.name} (${r.emp_id})`
    + (r.department ? ` — ${r.department}` : '')
    + (r.is_active ? '' : ' — INACTIVE');

  if (rows.length > 0) {
    return {
      count: rows.length,
      rows: rows.map(r => ({ ...r, display: display(r) })),
      notes: rows.length > 1
        ? ['More than one employee matched — ask which one before reporting.']
        : undefined,
    };
  }

  // Nothing matched literally. Rank the whole roster by resemblance and offer
  // the closest few, rather than reporting a flat "no such employee" for what
  // is usually a typo.
  // The same explicit columns the literal search selects. Deliberately NOT
  // safeEmployeeSelect(), which is a wider allowlist including email and phone:
  // a name lookup has no business returning contact details.
  const everyone = await query<Omit<EmployeeCandidate, 'display' | 'suggestion'>>(
    `SELECT e.id, e.emp_id, e.name, e.department, e.role, e.is_active, e.work_mode
       FROM employees e
      ${args.include_inactive ? '' : 'WHERE e.is_active = TRUE'}`,
  );

  const ranked = everyone
    .map(r => ({ r, score: similarity(search, r.name) }))
    .filter(x => x.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (ranked.length === 0) {
    return {
      count: 0,
      rows: [],
      notes: [
        `No employee matches "${search}", and nothing on the roster is close to it.`,
        'Do not guess. Say so, and offer to list the employees if that would help.',
      ],
    };
  }

  return {
    count: ranked.length,
    rows: ranked.map(({ r }) => ({ ...r, display: display(r), suggestion: true })),
    notes: [
      `No employee is spelled "${search}". These are the closest names on the roster.`,
      ranked.length === 1
        ? `Ask whether they meant ${ranked[0].r.name} before reporting anything. Do not assume.`
        : 'Ask which of these they meant before reporting anything. Do not assume.',
    ],
  };
}

export interface EmployeeProfile {
  id: number;
  emp_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  role: string;
  is_active: 0 | 1;
  work_mode: 'on_site' | 'off_site';
  allow_multiple_sessions: 0 | 1;
  live_tracking_enabled: 0 | 1;
  manager_name: string | null;
  shift_name: string | null;
  location_name: string | null;
}

/**
 * Profile for one employee.
 *
 * SECURITY: selects only SAFE_EMPLOYEE_COLUMNS — bank details, PAN and Aadhaar
 * are unreachable from the chat layer by construction.
 */
export async function getEmployeeProfile(
  ctx: ChatContext,
  args: { employee_id: number },
): Promise<ToolResult<EmployeeProfile>> {
  requireSuperAdmin(ctx);

  const rows = await query<EmployeeProfile>(
    `SELECT ${safeEmployeeSelect('e')},
            m.name  AS manager_name,
            s.name  AS shift_name,
            l.name  AS location_name
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
       LEFT JOIN employee_schedules es
              ON es.employee_id = e.id
             AND es.effective_from <= CURDATE()
             AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
       LEFT JOIN shifts    s ON s.id = es.shift_id
       LEFT JOIN locations l ON l.id = es.location_id
      WHERE e.id = ?
      ORDER BY es.effective_from DESC
      LIMIT 1`,
    [args.employee_id],
  );

  return { count: rows.length, rows };
}

export interface DepartmentRow {
  department: string;
  employee_count: number;
}

/** The departments that exist, for answering "which teams are there". */
export async function listDepartments(
  ctx: ChatContext,
): Promise<ToolResult<DepartmentRow>> {
  requireSuperAdmin(ctx);

  const rows = await query<DepartmentRow>(
    `SELECT COALESCE(e.department, 'Unassigned') AS department,
            COUNT(*)                            AS employee_count
       FROM employees e
      WHERE e.is_active = TRUE
      GROUP BY COALESCE(e.department, 'Unassigned')
      ORDER BY employee_count DESC, department ASC`,
  );

  return { count: rows.length, rows };
}
