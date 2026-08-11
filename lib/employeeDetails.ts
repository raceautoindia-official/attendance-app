import { z } from 'zod';
import { queryOne } from '@/lib/db';

// ---------------------------------------------------------------------------
// Bank & statutory identity fields (added 2026-07-23 migration)
// ---------------------------------------------------------------------------

/** SELECT fragment for the detail columns, with a fallback when the migration
 *  hasn't run yet (same defensive pattern as live_tracking_enabled). */
export const BANK_COLUMNS = [
  'bank_account_name',
  'bank_account_number',
  'bank_ifsc',
  'bank_name',
  'pan_number',
  'aadhaar_number',
] as const;

export async function hasBankColumns(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'bank_account_number'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** True once the 2026-07-30 work-mode migration has run. */
export async function hasWorkModeColumns(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'work_mode'`,
  );
  return Number(row?.c ?? 0) > 0;
}

export function workModeSelect(exists: boolean, alias = 'e'): string {
  return exists
    ? `${alias}.work_mode, ${alias}.allow_multiple_sessions`
    : `'on_site' AS work_mode, FALSE AS allow_multiple_sessions`;
}

/** True once employees has the per-employee live-tracking toggle. */
export async function hasLiveTrackingColumn(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'live_tracking_enabled'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** True once attendance has the multi-session columns. */
export async function hasSessionColumns(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = 'banked_minutes'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** True once the 2026-08-11 first-clock-in migration has run. */
export async function hasFirstClockInColumn(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = 'first_clock_in_utc'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** True once the 2026-08-11 out-of-fence REVIEW migration has run. */
export async function hasOutOfFenceReviewColumns(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = 'out_of_fence_status'`,
  );
  return Number(row?.c ?? 0) > 0;
}

/** True once the 2026-08-11 out-of-fence-reason migration has run. */
export async function hasOutOfFenceReasonColumn(): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance'
       AND COLUMN_NAME = 'out_of_fence_reason'`,
  );
  return Number(row?.c ?? 0) > 0;
}

export function bankSelect(exists: boolean, alias = 'e'): string {
  return exists
    ? BANK_COLUMNS.map(c => `${alias}.${c}`).join(', ')
    : BANK_COLUMNS.map(c => `NULL AS ${c}`).join(', ');
}

// Empty string from a form means "clear the field" → NULL.
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Validation for the bank/identity fields — shared by the admin employee
 *  update and the employee self-service profile update. */
export const BankDetailsSchema = z.object({
  bank_account_name: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  bank_account_number: z.preprocess(
    emptyToNull,
    z.string().regex(/^[A-Za-z0-9]{5,24}$/, 'Account number must be 5–24 letters/digits').nullable().optional(),
  ),
  bank_ifsc: z.preprocess(
    emptyToNull,
    z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'IFSC must look like SBIN0001234').nullable().optional(),
  ),
  bank_name: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  pan_number: z.preprocess(
    emptyToNull,
    z.string().regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/, 'PAN must look like ABCDE1234F').nullable().optional(),
  ),
  aadhaar_number: z.preprocess(
    emptyToNull,
    z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits').nullable().optional(),
  ),
});

export type BankDetails = z.infer<typeof BankDetailsSchema>;

/** Normalizes case (IFSC/PAN uppercase) and returns only the fields present. */
export function normalizeBankDetails(details: BankDetails): Partial<Record<(typeof BANK_COLUMNS)[number], string | null>> {
  const out: Partial<Record<(typeof BANK_COLUMNS)[number], string | null>> = {};
  for (const col of BANK_COLUMNS) {
    const value = details[col];
    if (value === undefined) continue;
    out[col] =
      value != null && (col === 'bank_ifsc' || col === 'pan_number')
        ? value.toUpperCase()
        : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = [
  'pan_card',
  'aadhaar_card',
  'bank_proof',
  'experience_certificate',
  'relieving_letter',
  'education_certificate',
  'offer_letter',
  'other',
] as const;

export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// nginx caps request bodies at 5m; base64 inflates ~33%, so 3MB of file keeps
// the JSON payload safely under that.
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

/** Who may see/manage an employee's details & documents:
 *  the employee themself, their manager, or a super admin. */
export async function canAccessEmployee(
  auth: { id: number; role: string },
  employeeId: number,
): Promise<boolean> {
  if (auth.id === employeeId) return true;
  if (auth.role === 'super_admin') return true;
  if (auth.role === 'manager') {
    const emp = await queryOne<{ manager_id: number | null }>(
      'SELECT manager_id FROM employees WHERE id = ?',
      [employeeId],
    );
    return emp?.manager_id === auth.id;
  }
  return false;
}
