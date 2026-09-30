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
