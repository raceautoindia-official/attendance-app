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

export type LeaveType = 'leave' | 'holiday';

// ---------------------------------------------------------------------------
// Domain models — mirror DB columns exactly
// ---------------------------------------------------------------------------

export interface Employee {
  id: number;
  emp_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  is_active: boolean;
  manager_id: number | null;
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
  clock_in_utc: Date | null;
  clock_out_utc: Date | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  ip_address: string | null;
  geofence_status: GeofenceStatus;
  auth_method: AuthMethod;
  total_minutes: number | null;
  status: AttendanceStatus;
  notes: string | null;
  edited_by: number | null;
  edited_at: Date | null;
  // Populated via JOIN
  employee_name?: string;
  emp_id?: string;
}

export interface LeaveRecord {
  id: number;
  /** NULL means the record applies to all employees (public holiday) */
  employee_id: number | null;
  leave_date: string; // "YYYY-MM-DD"
  type: LeaveType;
  description: string | null;
  created_by: number | null;
  created_at: Date;
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
