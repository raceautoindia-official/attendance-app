/**
 * lib/chat/types.ts — shared types for the admin chat data layer.
 *
 * The chat tool layer is READ-ONLY. Nothing in lib/chat/ may INSERT, UPDATE or
 * DELETE application data (audit logging is the sole exception, and it lives in
 * the route, not here).
 */

import type { Role } from '@/lib/types';

/**
 * The security context for a tool call. Built from the verified JWT in the
 * route handler — NEVER from model-supplied arguments. Tools derive every
 * access decision from this object alone.
 */
export interface ChatContext {
  /** employees.id of the signed-in user. */
  employeeId: number;
  role: Role;
}

/** A resolved, inclusive date range plus a human label for the answer. */
export interface DateRange {
  from: string; // YYYY-MM-DD (IST)
  to: string;   // YYYY-MM-DD (IST), inclusive
  label: string; // e.g. "1-31 August 2026"
}

/**
 * Every tool returns this envelope. `display` strings are pre-formatted for the
 * model to quote verbatim — it must never recompute or reformat them.
 */
export interface ToolResult<T> {
  /** The resolved period the data covers, echoed back so answers cite it. */
  range?: DateRange;
  /** Row count, so the model can say "12 employees" without counting. */
  count: number;
  rows: T[];
  /**
   * Caveats the model MUST surface if present — e.g. open clock-in sessions
   * that make today's totals provisional.
   */
  notes?: string[];
}

/** Thrown by tools when a request is valid but outside what the data covers. */
export class NoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDataError';
  }
}

/** Thrown when the caller lacks the role a tool requires. */
export class ChatForbiddenError extends Error {
  constructor(message = 'Not permitted for this account.') {
    super(message);
    this.name = 'ChatForbiddenError';
  }
}

/**
 * v1 exposes the chat to super_admin only. Every tool calls this first, so the
 * guarantee holds even if the route is later mounted with looser auth.
 */
export function requireSuperAdmin(ctx: ChatContext): void {
  if (ctx.role !== 'super_admin') {
    throw new ChatForbiddenError(
      'The assistant is available to super admins only.',
    );
  }
}

/**
 * Columns from `employees` the chat layer may ever read.
 *
 * SECURITY: bank_account_name, bank_account_number, bank_ifsc, bank_name,
 * pan_number, aadhaar_number and pin_hash are absent BY DESIGN. Never widen
 * this list, and never write `SELECT *` against employees in lib/chat/.
 */
export const SAFE_EMPLOYEE_COLUMNS = [
  'id',
  'emp_id',
  'name',
  'email',
  'phone',
  'department',
  'role',
  'is_active',
  'work_mode',
  'allow_multiple_sessions',
  'live_tracking_enabled',
  'manager_id',
] as const;

/** `e.id, e.emp_id, ...` for use in a SELECT list. */
export function safeEmployeeSelect(alias = 'e'): string {
  return SAFE_EMPLOYEE_COLUMNS.map(c => `${alias}.${c}`).join(', ');
}
