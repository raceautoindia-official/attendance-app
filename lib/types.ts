// ---------------------------------------------------------------------------
// Enums / union types
// ---------------------------------------------------------------------------

export type Role = 'employee' | 'manager' | 'super_admin';

export type ShiftType = 'fixed' | 'flexible' | 'rotating' | 'custom';

export type GeofenceStatus = 'inside' | 'outside' | 'not_required';

export type AuthMethod = 'webauthn' | 'pin_exemption';

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'early_departure'
  | 'absent'
  | 'leave'
  | 'holiday';

export type LeaveType = 'casual' | 'sick' | 'earned' | 'holiday' | 'other';

export type PermissionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * 'permission' — paid time OFF inside a working day; consumes the monthly
 *                quota and tops the day's hours up to the shift length.
 * 'on_duty'    — official work AWAY from the site; no quota, no credited
 *                hours, and the geofence must not clock them out.
 */
export type PermissionRequestType = 'permission' | 'on_duty';

export type DocumentType =
  | 'pan_card'
  | 'aadhaar_card'
  | 'bank_proof'
  | 'experience_certificate'
  | 'relieving_letter'
  | 'education_certificate'
  | 'offer_letter'
  | 'other';

// ---------------------------------------------------------------------------
// Domain models — mirror DB columns exactly
// ---------------------------------------------------------------------------

export interface Employee {
  id: number;
  emp_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  department?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_ifsc?: string | null;
  bank_name?: string | null;
  pan_number?: string | null;
  aadhaar_number?: string | null;
  role: Role;
  is_active: boolean;
  live_tracking_enabled?: boolean;
  /** on_site: geofence enforced; off_site: field staff, no geofence */
  work_mode?: 'on_site' | 'off_site';
  /** Plant staff — may clock in/out several times a day */
  allow_multiple_sessions?: boolean;
  manager_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Uploaded document metadata — file_data (base64) is never included in lists */
export interface EmployeeDocument {
  id: number;
  employee_id: number;
  doc_type: DocumentType;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: number | null;
  created_at: Date;
  // Populated via JOIN
  uploaded_by_name?: string | null;
}

/** Yearly leave entitlement; used/remaining are derived from leave_records */
export interface LeaveQuota {
  id: number;
  employee_id: number;
  year: number;
  casual_total: number;
  sick_total: number;
  earned_total: number;
  updated_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Employee row including the bcrypt hash — never send to clients */
export interface EmployeeWithHash extends Employee {
  pin_hash: string;
}

export interface Passkey {
  id: number;
  employee_id: number;
  credential_id: string;
  /** Base64url-encoded COSE public key */
  public_key: string;
  counter: number;
  device_name: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

export interface PasskeyExemption {
  id: number;
  employee_id: number;
  granted_by: number;
  reason: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface RefreshToken {
  id: number;
  employee_id: number;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface Location {
  id: number;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
  created_at: Date;
}

/** One entry in a rotating shift's weekly cycle */
export interface RotationSlot {
  name: string;
  start_time: string; // "HH:MM"
  end_time: string;   // "HH:MM"
  days: string[];     // ["Mon","Tue",...]
}

export interface Shift {
  id: number;
  name: string;
  type: ShiftType;
  /** "HH:MM:SS" — only meaningful for fixed shifts */
  start_time: string | null;
  /** "HH:MM:SS" — only meaningful for fixed shifts */
  end_time: string | null;
  /** Only meaningful for flexible shifts */
  required_hours: number | null;
  grace_minutes: number;
  working_days: string[];
  rotation_config: RotationSlot[] | null;
  created_by: number | null;
  created_at: Date;
}

export interface EmployeeSchedule {
  id: number;
  employee_id: number;
  shift_id: number;
  location_id: number | null;
  geofencing_enabled: boolean;
  effective_from: string; // "YYYY-MM-DD"
  effective_to: string | null;
  assigned_by: number | null;
  created_at: Date;
  // Populated via JOIN
  shift?: Shift;
  location?: Location | null;
}

export interface AttendanceRecord {
  id: number;
  employee_id: number;
  work_date: string; // "YYYY-MM-DD" — IST date
  /** The day's FIRST login. Never overwritten by later sessions — clock_in_utc
   *  is the CURRENT session's start and legitimately moves on re-open. */
  first_clock_in_utc?: Date | null;
  clock_in_utc: Date | null;
  clock_out_utc: Date | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  ip_address: string | null;
  geofence_status: GeofenceStatus;
  auth_method: AuthMethod | null;
  total_minutes: number | null;
  /** Minutes completed in earlier sessions today (multi-session employees) */
  banked_minutes?: number;
  session_count?: number;
  status: AttendanceStatus;
  notes: string | null;
  edited_by: number | null;
  edited_at: Date | null;
  // Populated via JOIN
  employee_name?: string;
  emp_id?: string;
  location_name?: string | null;
  location_address?: string | null;
  /** Approved permission minutes for this work_date */
  permission_minutes?: number;
  /** Minutes the day's shift requires (used to cap the permission credit) */
  required_minutes?: number;
  /** total_minutes topped up by approved permission, capped at required_minutes */
  credited_minutes?: number | null;
  /** Hours actually worked on the day (banked sessions included) */
  worked_minutes?: number | null;
  /** Why this clock-in was allowed from outside the work site, if it was. */
  out_of_fence_reason?: string | null;
  /** Worked past the overtime line — the part credited_minutes caps off */
  overtime_minutes?: number;
  /** How late the day's FIRST clock-in was, past shift start + grace.
   *  null when the day has no start time to be late against (flexible shift,
   *  or no schedule at all) — which is not the same as 0. */
  late_minutes?: number | null;
  /** Minutes between sessions: elapsed span minus time actually worked. */
  break_minutes?: number | null;
  /**
   * This session was closed by the away-from-site watchdog, not by a person.
   *
   * The phone re-opens the day on re-entry only for a closure of this kind or
   * one it performed itself; a manual or end-of-day closure means the day is
   * genuinely over and should stay closed.
   */
  auto_clocked_out?: boolean;
}

/**
 * One employee's whole day, for the admin's day view.
 *
 * Built from the EMPLOYEE outwards rather than from an attendance row, so
 * somebody who has not clocked in is still a row — with nulls where the day
 * has not happened yet. An AttendanceRecord cannot express that: it only
 * exists once there is something to record.
 */
export interface DayAttendanceRow {
  employee_id: number;
  employee_name: string;
  emp_id: string;
  role: string;
  /** null when no attendance row exists for the day yet. */
  attendance_id: number | null;
  clock_in_utc: Date | string | null;
  clock_out_utc: Date | string | null;
  first_clock_in_utc: Date | string | null;
  status: AttendanceStatus;
  /** null = nothing to report yet (not clocked in), not "outside". */
  geofence_status: GeofenceStatus | null;
  /** Is this employee fenced at all? Distinguishes "switched off" from "no reading". */
  geofencing_enabled: boolean;
  location_name: string | null;
  location_radius_m: number | null;
  out_of_fence_reason: string | null;
  worked_minutes: number | null;
  credited_minutes: number | null;
  required_minutes: number | null;
  permission_minutes: number;
  overtime_minutes: number;
  late_minutes: number | null;
  break_minutes: number | null;
  session_count: number;
  /** Was this employee due in at all today? False on their weekly off or a
   *  weekday their shift does not work — which is not the same as absent. */
  expected_today: boolean;
}

/** A short paid absence inside a working day, approved by an admin. */
export interface PermissionRequest {
  id: number;
  employee_id: number;
  request_type: PermissionRequestType;
  permission_date: string; // "YYYY-MM-DD"
  start_time: string;      // "HH:MM:SS" (IST wall clock)
  end_time: string;        // "HH:MM:SS"
  minutes: number;
  reason: string | null;
  status: PermissionStatus;
  requested_by: number | null;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
  updated_at: Date;
  /** Filed after the date it covers — shown to the approver. */
  is_backdated?: boolean | number;
  days_late?: number | null;
  // Populated via JOIN
  employee_name?: string | null;
  employee_emp_id?: string | null;
  reviewed_by_name?: string | null;
}

/** Monthly permission entitlement for one employee. */
export interface PermissionBalance {
  month: string;          // "YYYY-MM"
  monthly_limit_minutes: number;
  used_minutes: number;   // approved
  pending_minutes: number;
  remaining_minutes: number;
  max_minutes_per_request: number;
  min_minutes_per_request: number;
}

export interface LeaveRecord {
  id: number;
  /** NULL means the record applies to all employees (public holiday) */
  employee_id: number | null;
  leave_date: string; // "YYYY-MM-DD"
  leave_type: LeaveType;
  notes: string | null;
  created_by: number | null;
  created_at: Date;
}

export interface LiveTrackingSession {
  id: number;
  employee_id: number;
  started_at_utc: Date;
  ended_at_utc: Date | null;
  is_active: boolean;
  last_ping_utc: Date | null;
  created_at: Date;
}

export interface LiveTrackingPoint {
  id: number;
  session_id: number;
  employee_id: number;
  tracked_at_utc: Date;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
}

export interface AuditLog {
  id: number;
  action: string;
  entity: string;
  entity_id: number | null;
  performed_by: number | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
  // Populated via JOIN
  performed_by_name?: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface JWTPayload {
  id: number;
  emp_id: string;
  role: Role;
  iat?: number;
  exp?: number;
}

// ---------------------------------------------------------------------------
// Generic API response wrapper
// ---------------------------------------------------------------------------

export interface ApiResponse<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  /**
   * A stable identifier for a refusal the client must handle specially, e.g.
   * 'outside_fence', which makes the phone ask for a reason and retry.
   *
   * The message beside it is written for a person and carries a distance and a
   * site name, so it changes; matching on its text would break silently the
   * first time the wording did.
   */
  code?: string;
  /** Extra facts about a refusal — the fence's name, radius and how far out. */
  location_name?: string | null;
  radius_m?: number;
  distance_m?: number | null;
}

// ---------------------------------------------------------------------------
// Utility param shapes
// ---------------------------------------------------------------------------

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface DateRangeParams {
  from: string; // "YYYY-MM-DD"
  to: string;   // "YYYY-MM-DD"
}
