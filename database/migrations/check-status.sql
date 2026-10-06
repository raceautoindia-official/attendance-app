-- =============================================================================
-- check-status.sql — READ ONLY. Reports which migrations this database already
-- has, so you never run a non-idempotent ALTER twice.
--
-- Changes nothing. Safe to run on production at any time.
--
--   mysql -u <user> -p <database> < database/migrations/check-status.sql
--
-- Read the RESULT column of each row:
--   APPLIED  — that migration's changes are present; do NOT run it again
--   MISSING  — that migration still needs running
--   PARTIAL  — some artifacts present, some not. STOP and inspect before
--              running anything; the ALTER will fail halfway.
-- =============================================================================

SELECT '=== migration status for database:' AS ' ', DATABASE() AS ' ';

-- ---------------------------------------------------------------------------
-- 2026-05-26 .. 2026-06-03 (earlier migrations, for completeness)
-- ---------------------------------------------------------------------------
SELECT
  '2026-05-26_add_department_to_employees' AS migration,
  CASE WHEN COUNT(*) = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(COUNT(*), '/1 columns') AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'department';

SELECT
  '2026-05-27_add_live_tracking_tables' AS migration,
  CASE WHEN COUNT(*) = 2 THEN 'APPLIED'
       WHEN COUNT(*) = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(COUNT(*), '/2 tables') AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('live_tracking_sessions', 'live_tracking_points');

SELECT
  '2026-05-29_add_login_photo_and_daily_updates' AS migration,
  CASE WHEN COUNT(*) >= 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(COUNT(*), ' table(s)') AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_updates';

SELECT
  '2026-06-01_add_employee_live_tracking_toggle' AS migration,
  CASE WHEN COUNT(*) = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(COUNT(*), '/1 columns') AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'live_tracking_enabled';

SELECT
  '2026-05-28_add_webauthn_challenges_table' AS migration,
  CASE WHEN COUNT(*) = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(COUNT(*), '/1 tables') AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webauthn_challenges';

-- Easy to miss: this only widens a column, so nothing errors when it has not
-- run. But while attendance.auth_method stays NOT NULL, rows inserted by
-- markAbsentees / markSundayHolidays (which omit the column) silently receive
-- the FIRST enum value, 'webauthn' - so absent and holiday records claim a
-- passkey authentication that never happened.
SELECT
  '2026-06-03_attendance_auth_method_nullable' AS migration,
  CASE WHEN IS_NULLABLE = 'YES' THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT('auth_method IS_NULLABLE = ', IS_NULLABLE,
         ' (must be YES, else system-generated rows are mislabelled webauthn)') AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'attendance'
  AND COLUMN_NAME = 'auth_method';

-- How many rows the gap above has already mislabelled.
SELECT
  'INFO rows mislabelled auth_method' AS check_name,
  CONCAT(COUNT(*), ' row(s)') AS result,
  '2026-10-03_fix_auth_method_on_generated_rows clears these' AS detail
FROM attendance
WHERE clock_in_utc IS NULL
  AND auth_method IS NOT NULL
  AND status IN ('absent', 'holiday', 'leave');

-- ---------------------------------------------------------------------------
-- The four that ship with the reporting assistant's prerequisites
-- ---------------------------------------------------------------------------

-- 6 columns on employees + 2 new tables = 8 artifacts
SELECT
  '2026-07-23_add_employee_details_documents_leave_quotas' AS migration,
  CASE WHEN total = 8 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL — INSPECT BEFORE RUNNING' END AS result,
  CONCAT(total, '/8 artifacts') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
        AND COLUMN_NAME IN ('bank_account_name','bank_account_number','bank_ifsc',
                            'bank_name','pan_number','aadhaar_number'))
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('employee_documents','leave_quotas')) AS total
) t;

-- Data-only repair: idempotent, so it is always safe to run.
SELECT
  '2026-07-29_fix_tracking_points_before_session_start' AS migration,
  CASE WHEN COUNT(*) = 0 THEN 'APPLIED (no bad rows)'
       ELSE 'NEEDS RUNNING' END AS result,
  CONCAT(COUNT(*), ' point(s) predate their session — safe to re-run any time') AS detail
FROM live_tracking_points p
JOIN live_tracking_sessions s ON s.id = p.session_id
WHERE p.tracked_at_utc < s.started_at_utc;

-- 2 columns on employees + 2 on attendance = 4 artifacts
SELECT
  '2026-07-30_geofence_modes_multi_session' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL — INSPECT BEFORE RUNNING' END AS result,
  CONCAT(total, '/4 columns') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
        AND COLUMN_NAME IN ('work_mode','allow_multiple_sessions'))
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
        AND COLUMN_NAME IN ('banked_minutes','session_count')) AS total
) t;

SELECT
  '2026-07-30_unique_active_tracking_session' AS migration,
  CASE WHEN total = 2 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL — INSPECT BEFORE RUNNING' END AS result,
  CONCAT(total, '/2 artifacts (generated column + unique key)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_sessions'
        AND COLUMN_NAME = 'active_employee_id')
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_sessions'
        AND INDEX_NAME = 'uq_live_tracking_sessions_active_emp'
        AND SEQ_IN_INDEX = 1) AS total
) t;

SELECT
  '2026-10-03_holiday_calendar' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL - INSPECT BEFORE RUNNING' END AS result,
  CONCAT(total, '/4 artifacts (2 tables + locations.state_code + leave_records.location_id)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('holiday_calendar','holiday_observances'))
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations'
        AND COLUMN_NAME = 'state_code')
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_records'
        AND COLUMN_NAME = 'location_id') AS total
) t;

-- The NULL-safe unique keys are what make the holiday import idempotent and stop
-- duplicate all-locations decisions. A plain UNIQUE on the nullable column does
-- NOT dedupe, so verify both generated columns exist.
SELECT
  'holiday calendar NULL-safe unique keys' AS check_name,
  CASE WHEN total = 2 THEN 'OK' ELSE 'MISSING - re-import will duplicate rows' END AS result,
  CONCAT(total, '/2 generated key columns') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
        AND COLUMN_NAME = 'state_key')
    +
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_observances'
        AND COLUMN_NAME = 'location_key') AS total
) t;

-- ---------------------------------------------------------------------------
-- Things worth eyeballing before a deploy
-- ---------------------------------------------------------------------------

-- Duplicate active sessions block the unique key in the migration above.
SELECT
  'PRE-CHECK duplicate active tracking sessions' AS check_name,
  CASE WHEN COUNT(*) = 0 THEN 'OK'
       ELSE 'the migration will close the older ones' END AS result,
  CONCAT(COUNT(*), ' employee(s) with more than one active session') AS detail
FROM (
  SELECT employee_id
  FROM live_tracking_sessions
  WHERE is_active = TRUE
  GROUP BY employee_id
  HAVING COUNT(*) > 1
) d;

-- A very stale active session usually means a device stopped reporting.
SELECT
  'INFO stale active tracking sessions' AS check_name,
  CONCAT(COUNT(*), ' session(s) with no ping for over a day') AS result,
  'Not a blocker; worth closing manually' AS detail
FROM live_tracking_sessions
WHERE is_active = TRUE
  AND (last_ping_utc IS NULL OR last_ping_utc < UTC_TIMESTAMP() - INTERVAL 1 DAY);

-- effective_to before effective_from is inconsistent schedule data.
SELECT
  'INFO schedules with effective_to before effective_from' AS check_name,
  CONCAT(COUNT(*), ' row(s)') AS result,
  'Not a blocker; treated as not-current by the app' AS detail
FROM employee_schedules
WHERE effective_to IS NOT NULL AND effective_to < effective_from;

-- ---------------------------------------------------------------------------
-- Later migrations, added as they land. check-status is only useful if it
-- keeps pace with database/migrations/ — a blind spot here reads as a clean
-- bill of health.
-- ---------------------------------------------------------------------------

SELECT
  '2026-08-04_add_permission_requests' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 tables') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
) t;

SELECT
  '2026-08-08_add_device_binding' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 tables') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices'
) t;

SELECT
  '2026-08-08_add_token_version' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 columns (logout cannot revoke tokens without it)') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
     AND COLUMN_NAME = 'token_version'
) t;

SELECT
  '2026-08-11_add_first_clock_in' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 columns (without it, a multi-session day reports the LAST clock-in as its start)') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
     AND COLUMN_NAME = 'first_clock_in_utc'
) t;

SELECT
  '2026-08-12_add_password_resets' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 tables') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_resets'
) t;

SELECT
  '2026-10-06_shift_unpaid_break' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 columns (NULL on every shift = no change to any existing figure)') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts'
     AND COLUMN_NAME = 'unpaid_break_minutes'
) t;

SELECT
  'INFO shifts with a break policy set' AS check_name,
  CONCAT(COUNT(*), ' shift(s)') AS result,
  'Each one reduces its required hours by that many minutes per working day' AS detail
FROM shifts WHERE unpaid_break_minutes IS NOT NULL;
