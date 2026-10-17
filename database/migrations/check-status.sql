-- =============================================================================
-- check-status.sql -- READ ONLY. Reports which migrations this database already
-- has, so you never run a non-idempotent ALTER twice.
--
-- Changes nothing. Safe to run on production at any time.
--
--   mysql -u <user> -p <database> < database/migrations/check-status.sql
--
-- Read the RESULT column of each row:
--   APPLIED  -- that migration's changes are present; do NOT run it again
--   MISSING  -- that migration still needs running
--   PARTIAL  -- some artifacts present, some not. STOP and inspect before
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
-- daily_work_updates, not daily_updates. The wrong name here reported the
-- migration MISSING on a database where it had plainly been applied, which
-- invites somebody re-running it.
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_work_updates';

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
       ELSE 'PARTIAL -- INSPECT BEFORE RUNNING' END AS result,
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
  CONCAT(COUNT(*), ' point(s) predate their session -- safe to re-run any time') AS detail
FROM live_tracking_points p
JOIN live_tracking_sessions s ON s.id = p.session_id
WHERE p.tracked_at_utc < s.started_at_utc;

-- 2 columns on employees + 2 on attendance = 4 artifacts
SELECT
  '2026-07-30_geofence_modes_multi_session' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL -- INSPECT BEFORE RUNNING' END AS result,
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
       ELSE 'PARTIAL -- INSPECT BEFORE RUNNING' END AS result,
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
-- keeps pace with database/migrations/ -- a blind spot here reads as a clean
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

-- Guarded: a status check must be runnable BEFORE the migration it reports
-- on, or it crashes and hides every check below it.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts' AND COLUMN_NAME = 'unpaid_break_minutes');
SET @sql := IF(@have = 1, 'SELECT ''INFO shifts with a break policy set'' AS check_name, CONCAT(COUNT(*), '' shift(s)'') AS result, ''Each one reduces its required hours by that many minutes per working day'' AS detail FROM shifts WHERE unpaid_break_minutes IS NOT NULL', 'SELECT ''INFO shifts with a break policy set'' AS check_name, ''n/a'' AS result, ''column not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SELECT
  '2026-10-06_month_closures' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 tables') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'month_closures'
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'month_closures');
SET @sql := IF(@have = 1, 'SELECT ''INFO closed months'' AS check_name, COALESCE(GROUP_CONCAT(DATE_FORMAT(period_month, ''%Y-%m'') ORDER BY period_month SEPARATOR '', ''), ''none'') AS result, ''Attendance and leave inside these are read-only until reopened'' AS detail FROM month_closures WHERE is_closed = TRUE', 'SELECT ''INFO closed months'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SELECT
  '2026-10-06_regularisation_requests' AS migration,
  CASE WHEN total = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(total, '/1 tables') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regularisation_requests'
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regularisation_requests');
SET @sql := IF(@have = 1, 'SELECT ''INFO pending corrections'' AS check_name, CONCAT(COUNT(*), '' request(s)'') AS result, ''Attendance corrections waiting for a decision'' AS detail FROM regularisation_requests WHERE status = ''pending''', 'SELECT ''INFO pending corrections'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-07_policies
--
-- Three artifacts, and they can genuinely land apart: the two CREATE TABLEs
-- are guarded by IF NOT EXISTS, while widening employee_documents.doc_type is
-- an ALTER on a table that already holds rows. Tables present but the enum not
-- widened is the PARTIAL state -- the Policies page works and a government-ID
-- upload is rejected by the database.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-07_policies' AS migration,
  CASE WHEN total = 3 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/3 artifacts (policies + employee_policies + government-ID doc types)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_policies')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
        AND COLUMN_NAME = 'doc_type' AND COLUMN_TYPE LIKE '%government_id%') AS total
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_policies');
SET @sql := IF(@have = 1, 'SELECT ''INFO employees on a policy'' AS check_name, CONCAT(COUNT(DISTINCT employee_id), '' employee(s)'') AS result, ''Anyone not listed is computed exactly as before policies existed'' AS detail FROM employee_policies WHERE effective_to IS NULL', 'SELECT ''INFO employees on a policy'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-07_documents_s3
--
-- Four artifacts, all ALTERs on a live table, so PARTIAL is the state to watch
-- for. The one that matters most is file_data becoming NULLable: without it an
-- S3 upload cannot be recorded at all, because there are no bytes to store.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-07_documents_s3' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/4 artifacts (storage + s3_key + file_data NULLable + index)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'storage')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 's3_key')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
        AND COLUMN_NAME = 'file_data' AND IS_NULLABLE = 'YES')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
        AND INDEX_NAME = 'idx_doc_storage_created' AND SEQ_IN_INDEX = 1) AS total
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'storage');
SET @sql := IF(@have = 1, 'SELECT ''INFO documents by storage'' AS check_name, CONCAT(COALESCE(SUM(storage = ''db''), 0), '' in the database, '', COALESCE(SUM(storage = ''s3''), 0), '' in S3'') AS result, ''An S3 row cannot be opened on a server with no bucket configured'' AS detail FROM employee_documents', 'SELECT ''INFO documents by storage'' AS check_name, ''n/a'' AS result, ''storage column not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-10_org_structure
--
-- Five tables plus four column additions, so PARTIAL is very much reachable:
-- the CREATEs are guarded by IF NOT EXISTS, while the ALTERs touch live tables
-- and one of them (employees.joined_on) is what onboarding schedules against.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-10_org_structure' AS migration,
  CASE WHEN total = 9 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/9 artifacts (5 tables + locations.country_code/city + holiday country + employees.joined_on)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
        ('companies','departments','grades','teams','employee_org_assignments'))
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'country_code')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'city')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar' AND COLUMN_NAME = 'country_code')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'joined_on') AS total
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_org_assignments');
SET @sql := IF(@have = 1, 'SELECT ''INFO employees placed in the org'' AS check_name, CONCAT(COUNT(DISTINCT employee_id), '' of '', (SELECT COUNT(*) FROM employees WHERE is_active = TRUE), '' active'') AS result, ''Anyone not placed is invisible to department-scoped permissions'' AS detail FROM employee_org_assignments WHERE effective_to IS NULL', 'SELECT ''INFO employees placed in the org'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'departments');
SET @sql := IF(@have = 1, 'SELECT ''INFO department tree'' AS check_name, CONCAT(COUNT(*), '' department(s), deepest level '', COALESCE(MAX(depth), 0) + 1) AS result, ''Level 1 is a department with no parent'' AS detail FROM departments WHERE is_active = TRUE', 'SELECT ''INFO department tree'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-10_rbac
--
-- Four tables plus a seeded catalogue. The seeds matter as much as the tables:
-- an employee with no explicit role falls back to the SYSTEM role matching
-- employees.role, so a missing 'manager' role would silently leave every
-- manager with no permissions at all rather than failing loudly.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-10_rbac' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/4 tables (permissions, roles, role_permissions, employee_roles)') AS detail
FROM (
  SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME IN ('permissions','roles','role_permissions','employee_roles')
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roles');
SET @sql := IF(@have = 1, 'SELECT ''INFO system roles seeded'' AS check_name, CONCAT(COUNT(*), '' of 3'') AS result, ''Missing one leaves everybody on that legacy role with no permissions'' AS detail FROM roles WHERE is_system = TRUE AND code IN (''super_admin'',''manager'',''employee'')', 'SELECT ''INFO system roles seeded'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_roles');
SET @sql := IF(@have = 1, 'SELECT ''INFO people on an explicit role'' AS check_name, CONCAT(COUNT(DISTINCT employee_id), '' employee(s)'') AS result, ''Zero means access control is inert and employees.role still decides everything'' AS detail FROM employee_roles', 'SELECT ''INFO people on an explicit role'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-10_onboarding
--
-- Four tables plus three column additions. The seeded templates matter as
-- much as the tables: a journey started with no template produces an empty
-- checklist, which reports as 100% complete the moment it is created.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-10_onboarding' AS migration,
  CASE WHEN total = 7 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/7 artifacts (4 tables + last_working_day + probation_ends_on + document expiry)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
        ('onboarding_templates','onboarding_template_tasks','employee_onboarding','employee_onboarding_tasks'))
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'last_working_day')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'probation_ends_on')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'expires_on') AS total
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'onboarding_templates');
SET @sql := IF(@have = 1, 'SELECT ''INFO default checklists'' AS check_name, CONCAT(COUNT(*), '' of 2 directions'') AS result, ''Without one, starting somebody produces an empty checklist that reads as already complete'' AS detail FROM onboarding_templates WHERE is_default = TRUE AND is_active = TRUE', 'SELECT ''INFO default checklists'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_onboarding_tasks');
SET @sql := IF(@have = 1, 'SELECT ''INFO overdue onboarding tasks'' AS check_name, CONCAT(COUNT(*), '' task(s)'') AS result, ''Pending, dated in the past, on a checklist still open'' AS detail FROM employee_onboarding_tasks t JOIN employee_onboarding j ON j.id = t.journey_id AND j.status = ''in_progress'' WHERE t.status = ''pending'' AND t.due_on < CURDATE()', 'SELECT ''INFO overdue onboarding tasks'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-10_holidays_multi_country
--
-- The unique key is the artifact that matters. It used to be
-- (holiday_date, name, state_key) with no country, so importing a second
-- country silently dropped every date it shared with the first - Christmas
-- being the obvious one. PARTIAL here means the key was dropped and not yet
-- recreated, which allows real duplicates, so it is worth stopping for.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-10_holidays_multi_country' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/4 artifacts (source enum + region_code + country-aware unique key + holiday_countries)') AS detail
FROM (
  SELECT
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
        AND COLUMN_NAME = 'source' AND COLUMN_TYPE LIKE '%library%')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar' AND COLUMN_NAME = 'region_code')
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
        AND INDEX_NAME = 'uq_holiday_country' AND SEQ_IN_INDEX = 1)
  + (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_countries') AS total
) t;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_countries');
SET @sql := IF(@have = 1, 'SELECT ''INFO countries tracked'' AS check_name, CONCAT(COUNT(*), '' country/region(s)'') AS result, ''Only these appear as load buttons on the holiday page'' AS detail FROM holiday_countries WHERE is_active = TRUE', 'SELECT ''INFO countries tracked'' AS check_name, ''n/a'' AS result, ''table not present yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar' AND COLUMN_NAME = 'source' AND COLUMN_TYPE LIKE '%library%');
SET @sql := IF(@have = 1, 'SELECT ''INFO holiday candidates by source'' AS check_name, CONCAT(COALESCE(SUM(source=''bundled''),0), '' bundled, '', COALESCE(SUM(source=''library''),0), '' computed, '', COALESCE(SUM(source=''manual''),0), '' entered'') AS result, ''A candidate changes no working day until it is observed'' AS detail FROM holiday_calendar', 'SELECT ''INFO holiday candidates by source'' AS check_name, ''n/a'' AS result, ''source enum not widened yet'' AS detail');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 2026-10-11_org_scope_indexes
--
-- Index-only. Nothing breaks without them; the permission check simply filters
-- the date range row by row after the index lookup, which is invisible at
-- seventeen employees and costs every page at once at two thousand.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-11_org_scope_indexes' AS migration,
  CASE WHEN total = 4 THEN 'APPLIED'
       WHEN total = 0 THEN 'MISSING'
       ELSE 'PARTIAL' END AS result,
  CONCAT(total, '/4 indexes (org dept+dates, org team+dates, role scope, holiday country+year)') AS detail
FROM (
  SELECT COUNT(DISTINCT INDEX_NAME) AS total FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND INDEX_NAME IN ('idx_org_dept_dates','idx_org_team_dates',
                        'idx_rp_role_scope','idx_holiday_country_year')
) t;

-- ---------------------------------------------------------------------------
-- 2026-10-16_push_tokens
--
-- Optional for the app to run: without it the phone keeps announcing
-- approvals itself, which only reaches someone when they open the app.
-- ---------------------------------------------------------------------------
SELECT
  '2026-10-16_push_tokens' AS migration,
  CASE WHEN COUNT(*) = 1 THEN 'APPLIED' ELSE 'MISSING' END AS result,
  CONCAT(COUNT(*), '/1 tables') AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'push_tokens';
