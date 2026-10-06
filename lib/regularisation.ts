import { query, queryOne, insertAuditLog } from '@/lib/db';
import { toYmd } from '@/lib/date';
import { assertDateWritable } from '@/lib/monthClose';
import { getWorkDateIST } from '@/lib/attendance';

/**
 * lib/regularisation.ts — "I forgot to clock out" with a paper trail.
 *
 * WHY
 * ---
 * Somebody who forgets to clock out loses hours, and the only remedy today is
 * an administrator editing the attendance row. That edit is recorded, but the
 * REQUEST is not: who asked, what they said happened, who agreed, and why all
 * live in somebody's memory or a message thread. The correction and its
 * justification end up in different places, which is precisely what an audit
 * needs them not to be.
 *
 * So the exchange is the record. An employee states the times they say are
 * right and why; somebody with the authority to edit attendance approves or
 * rejects with a note; approval applies the change and writes the audit entry.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a way for an employee to edit their own attendance. A request
 * changes nothing until it is approved by somebody who could have made the edit
 * directly, and a request against a closed month is refused exactly as a direct
 * edit is. The authority is unchanged; only the trail is new.
 */

export type RegStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface RegularisationRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  emp_id: string;
  work_date: string;
  requested_clock_in: string | null;
  requested_clock_out: string | null;
  reason: string;
  status: RegStatus;
  requested_by: number | null;
  requested_by_name: string | null;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  previous_clock_in: string | null;
  previous_clock_out: string | null;
  previous_total_minutes: number | null;
  created_at: string;
}

const SELECT = `
  SELECT r.*,
         e.name  AS employee_name,
         e.emp_id,
         rq.name AS requested_by_name,
         rv.name AS reviewed_by_name
    FROM regularisation_requests r
    JOIN employees e  ON e.id = r.employee_id
    LEFT JOIN employees rq ON rq.id = r.requested_by
    LEFT JOIN employees rv ON rv.id = r.reviewed_by`;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function toRequest(r: Record<string, unknown>): RegularisationRequest {
  return {
    id: Number(r.id),
    employee_id: Number(r.employee_id),
    employee_name: String(r.employee_name),
    emp_id: String(r.emp_id),
    work_date: toYmd(r.work_date),
    requested_clock_in: iso(r.requested_clock_in),
    requested_clock_out: iso(r.requested_clock_out),
    reason: String(r.reason),
    status: r.status as RegStatus,
    requested_by: r.requested_by == null ? null : Number(r.requested_by),
    requested_by_name: (r.requested_by_name as string) ?? null,
    reviewed_by: r.reviewed_by == null ? null : Number(r.reviewed_by),
    reviewed_by_name: (r.reviewed_by_name as string) ?? null,
    reviewed_at: iso(r.reviewed_at),
    review_notes: (r.review_notes as string) ?? null,
    previous_clock_in: iso(r.previous_clock_in),
    previous_clock_out: iso(r.previous_clock_out),
    previous_total_minutes: r.previous_total_minutes == null ? null : Number(r.previous_total_minutes),
    created_at: iso(r.created_at) ?? '',
  };
}

export async function listRequests(params: {
  status?: RegStatus | 'all';
  employeeId?: number;
  /** Non-null narrows to a manager's own reports. */
  managerId?: number | null;
  limit?: number;
}): Promise<RegularisationRequest[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.status && params.status !== 'all') { where.push('r.status = ?'); args.push(params.status); }
  if (params.employeeId) { where.push('r.employee_id = ?'); args.push(params.employeeId); }
  if (params.managerId != null) { where.push('e.manager_id = ?'); args.push(params.managerId); }

  const rows = await query<Record<string, unknown>>(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(r.status, 'pending', 'approved', 'rejected', 'cancelled'), r.work_date DESC, r.id DESC
     LIMIT ?`,
    [...args, params.limit ?? 100],
  );
  return rows.map(toRequest);
}

export async function getRequest(id: number): Promise<RegularisationRequest | null> {
  const row = await queryOne<Record<string, unknown>>(`${SELECT} WHERE r.id = ?`, [id]);
  return row ? toRequest(row) : null;
}

/** Raise a request. Changes no attendance — that only happens on approval. */
export async function createRequest(params: {
  employeeId: number;
  workDate: string;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  requestedBy: number;
  ip?: string | null;
}): Promise<RegularisationRequest> {
  const { employeeId, workDate, requestedClockIn, requestedClockOut, reason, requestedBy, ip = null } = params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error('work_date must be YYYY-MM-DD.');
  if (!reason || reason.trim().length < 5) {
    throw new Error('Say what happened — the reason is the point of the request.');
  }
  if (!requestedClockIn && !requestedClockOut) {
    throw new Error('Give at least one corrected time.');
  }

  // Refused for the same reason a direct edit is: the month was signed off.
  await assertDateWritable(workDate);

  const employee = await queryOne<{ id: number }>(
    `SELECT id FROM employees WHERE id = ?`, [employeeId],
  );
  if (!employee) throw new Error('No such employee.');

  // The corrected times have to belong to the day being corrected, or an
  // approval would silently move hours onto a different date.
  for (const [label, value] of [['clock-in', requestedClockIn], ['clock-out', requestedClockOut]] as const) {
    if (!value) continue;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`The ${label} is not a valid time.`);
    const belongsTo = getWorkDateIST(parsed);
    if (belongsTo !== workDate) {
      throw new Error(
        `That ${label} falls on ${belongsTo}, not ${workDate}. `
        + 'Raise the request against the day the hours belong to.',
      );
    }
  }
  if (requestedClockIn && requestedClockOut
    && new Date(requestedClockOut) <= new Date(requestedClockIn)) {
    throw new Error('The clock-out must be after the clock-in.');
  }

  const duplicate = await queryOne<{ id: number }>(
    `SELECT id FROM regularisation_requests
      WHERE employee_id = ? AND work_date = ? AND status = 'pending'`,
    [employeeId, workDate],
  );
  if (duplicate) {
    throw new Error(`There is already a pending request for ${workDate}. Review that one first.`);
  }

  // Date objects, not ISO strings: MySQL rejects "2019-09-10T12:30:00.000Z" for
  // a DATETIME column. mysql2 serialises a Date using the pool's timezone,
  // which is UTC, so the stored value matches every other timestamp here.
  const res = (await query(
    `INSERT INTO regularisation_requests
       (employee_id, work_date, requested_clock_in, requested_clock_out, reason, requested_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      employeeId, workDate,
      requestedClockIn ? new Date(requestedClockIn) : null,
      requestedClockOut ? new Date(requestedClockOut) : null,
      reason.trim(), requestedBy,
    ],
  )) as unknown as { insertId: number };

  await insertAuditLog({
    action: 'regularisation_requested',
    entity: 'regularisation_request',
    entity_id: res.insertId,
    performed_by: requestedBy,
    ip_address: ip,
    details: { employee_id: employeeId, work_date: workDate, reason: reason.trim() },
  });

  return (await getRequest(res.insertId))!;
}

/**
 * Approve a request and apply it.
 *
 * The previous values are stored on the request before the write, so the change
 * is reversible and legible without reading the audit log back.
 */
export async function approveRequest(params: {
  id: number;
  reviewedBy: number;
  notes?: string | null;
  ip?: string | null;
}): Promise<RegularisationRequest> {
  const { id, reviewedBy, notes = null, ip = null } = params;

  const request = await getRequest(id);
  if (!request) throw new Error('No such request.');
  if (request.status !== 'pending') {
    throw new Error(`That request is already ${request.status}.`);
  }

  // Re-checked at approval, not just at creation: a month can be closed while a
  // request sits in the queue, and approving then would edit a signed-off month.
  await assertDateWritable(request.work_date);

  const existing = await queryOne<{
    id: number; clock_in_utc: Date | null; clock_out_utc: Date | null;
    total_minutes: number | null; banked_minutes: number; status: string;
  }>(
    `SELECT id, clock_in_utc, clock_out_utc, total_minutes, banked_minutes, status
       FROM attendance WHERE employee_id = ? AND work_date = ?`,
    [request.employee_id, request.work_date],
  );

  const newIn = request.requested_clock_in
    ? new Date(request.requested_clock_in)
    : existing?.clock_in_utc ?? null;
  const newOut = request.requested_clock_out
    ? new Date(request.requested_clock_out)
    : existing?.clock_out_utc ?? null;

  if (newIn && newOut && newOut <= newIn) {
    throw new Error('Applying this would put the clock-out before the clock-in.');
  }

  // Worked minutes are the span plus whatever earlier sessions banked. Anything
  // already banked belongs to sessions this correction does not touch.
  const banked = Number(existing?.banked_minutes ?? 0);
  const span = newIn && newOut
    ? Math.max(0, Math.round((newOut.getTime() - newIn.getTime()) / 60_000))
    : null;
  const total = span == null ? existing?.total_minutes ?? null : span + banked;

  if (existing) {
    await query(
      `UPDATE attendance
          SET clock_in_utc = ?, clock_out_utc = ?, total_minutes = ?,
              status = CASE WHEN status = 'absent' AND ? IS NOT NULL THEN 'present' ELSE status END,
              edited_by = ?, edited_at = NOW()
        WHERE id = ?`,
      [newIn, newOut, total, newIn, reviewedBy, existing.id],
    );
  } else {
    // No row for the day at all — the employee never clocked in, and the
    // approved request is the record of what they did.
    await query(
      `INSERT INTO attendance
         (employee_id, work_date, status, clock_in_utc, clock_out_utc, total_minutes,
          session_count, banked_minutes, edited_by, edited_at)
       VALUES (?, ?, 'present', ?, ?, ?, 1, 0, ?, NOW())`,
      [request.employee_id, request.work_date, newIn, newOut, total, reviewedBy],
    );
  }

  await query(
    `UPDATE regularisation_requests
        SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?,
            previous_clock_in = ?, previous_clock_out = ?, previous_total_minutes = ?
      WHERE id = ?`,
    [reviewedBy, notes,
      existing?.clock_in_utc ?? null, existing?.clock_out_utc ?? null,
      existing?.total_minutes ?? null, id],
  );

  await insertAuditLog({
    action: 'regularisation_approved',
    entity: 'regularisation_request',
    entity_id: id,
    performed_by: reviewedBy,
    ip_address: ip,
    details: {
      employee_id: request.employee_id,
      work_date: request.work_date,
      reason: request.reason,
      notes,
      before: {
        clock_in: existing?.clock_in_utc ?? null,
        clock_out: existing?.clock_out_utc ?? null,
        total_minutes: existing?.total_minutes ?? null,
      },
      after: { clock_in: newIn, clock_out: newOut, total_minutes: total },
    },
  });

  return (await getRequest(id))!;
}

/** Reject a request. Nothing is applied; the reason for refusing is recorded. */
export async function rejectRequest(params: {
  id: number;
  reviewedBy: number;
  notes: string;
  ip?: string | null;
}): Promise<RegularisationRequest> {
  const { id, reviewedBy, notes, ip = null } = params;
  if (!notes || notes.trim().length < 3) {
    throw new Error('Say why it is being rejected — the employee will see this.');
  }
  const request = await getRequest(id);
  if (!request) throw new Error('No such request.');
  if (request.status !== 'pending') throw new Error(`That request is already ${request.status}.`);

  await query(
    `UPDATE regularisation_requests
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
      WHERE id = ?`,
    [reviewedBy, notes.trim(), id],
  );

  await insertAuditLog({
    action: 'regularisation_rejected',
    entity: 'regularisation_request',
    entity_id: id,
    performed_by: reviewedBy,
    ip_address: ip,
    details: { employee_id: request.employee_id, work_date: request.work_date, notes: notes.trim() },
  });

  return (await getRequest(id))!;
}

/** Withdraw your own pending request. */
export async function cancelRequest(params: {
  id: number;
  by: number;
  ip?: string | null;
}): Promise<RegularisationRequest> {
  const request = await getRequest(params.id);
  if (!request) throw new Error('No such request.');
  if (request.status !== 'pending') throw new Error(`That request is already ${request.status}.`);

  await query(
    `UPDATE regularisation_requests SET status = 'cancelled' WHERE id = ?`, [params.id],
  );
  await insertAuditLog({
    action: 'regularisation_cancelled',
    entity: 'regularisation_request',
    entity_id: params.id,
    performed_by: params.by,
    ip_address: params.ip ?? null,
    details: { employee_id: request.employee_id, work_date: request.work_date },
  });
  return (await getRequest(params.id))!;
}
