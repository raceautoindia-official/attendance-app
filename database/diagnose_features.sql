-- =============================================================================
-- WHY IS A FEATURE SILENTLY DOING NOTHING?
--
--   mysql -u <user> -p <database> < database/diagnose_features.sql
--
-- Several features are guarded by "does this column exist yet?" checks so the
-- app keeps running on a database that predates them. The cost of that safety
-- is that a MISSING MIGRATION looks exactly like a broken feature: no error,
-- no log, the feature just never happens.
--
-- Section 1 is the first thing to read. Any 'MISSING' there explains a dead
-- feature completely, and no amount of toggling switches in the admin UI will
-- help until the migration is run.
-- =============================================================================

-- 1. SCHEMA GATES -------------------------------------------------------------
SELECT 'employees.live_tracking_enabled' AS db_object,
       IF(COUNT(*) > 0, 'present', 'MISSING') AS state,
       'Live tracking, location-off warnings, geofence auto clock-out' AS feature_it_controls,
       '2026-06-01_add_employee_live_tracking_toggle.sql' AS migration
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'live_tracking_enabled'
UNION ALL
SELECT 'employees.work_mode',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Geofence watchdog — returns 0 immediately without this, so NOBODY is auto clocked out',
       '2026-07-30_geofence_modes_multi_session.sql'
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'work_mode'
UNION ALL
SELECT 'employees.allow_multiple_sessions',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Several clock-ins in one day',
       '2026-07-30_geofence_modes_multi_session.sql'
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'allow_multiple_sessions'
UNION ALL
SELECT 'attendance.banked_minutes',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Multi-session hours — without it a second clock-in cannot bank the first session',
       '2026-07-30_geofence_modes_multi_session.sql'
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND COLUMN_NAME = 'banked_minutes'
UNION ALL
SELECT 'attendance.session_count',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Multi-session counting',
       '2026-07-30_geofence_modes_multi_session.sql'
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND COLUMN_NAME = 'session_count'
UNION ALL
SELECT 'live_tracking_sessions table',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Any location reporting at all',
       '2026-05-27_add_live_tracking_tables.sql'
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_sessions'
UNION ALL
SELECT 'permission_requests table',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Permission hours and on-duty',
       '2026-08-10_production_deploy.sql'
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
UNION ALL
SELECT 'employees.token_version',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Logout actually revoking access tokens',
       '2026-08-10_production_deploy.sql'
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'token_version'
UNION ALL
SELECT 'employee_devices table',
       IF(COUNT(*) > 0, 'present', 'MISSING'),
       'Device binding',
       '2026-08-10_production_deploy.sql'
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices';


-- 2. PER-EMPLOYEE SWITCHES ----------------------------------------------------
-- Only meaningful once section 1 is all 'present'. Columns that do not exist
-- are reported as 'no column' rather than a misleading 'off'.
SET @has_track := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='live_tracking_enabled');
SET @has_mode := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='work_mode');
SET @has_multi := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME='allow_multiple_sessions');

SET @sql := CONCAT('
SELECT e.emp_id, e.name,
       ', IF(@has_mode,  'IF(e.work_mode = ''on_site'', ''on_site'', CONCAT(''NO ('', e.work_mode, '')''))', '''no column'''), ' AS on_site,
       ', IF(@has_track, 'IF(e.live_tracking_enabled = 1, ''yes'', ''OFF'')',                                 '''no column'''), ' AS tracking,
       ', IF(@has_multi, 'IF(e.allow_multiple_sessions = 1, ''yes'', ''OFF'')',                               '''no column'''), ' AS multi_login,
       COALESCE(l.name, ''NO LOCATION'') AS work_location,
       IF(es.geofencing_enabled = 1, ''yes'', ''OFF'') AS geofence_on
  FROM employees e
  LEFT JOIN employee_schedules es ON es.id = (
        SELECT id FROM employee_schedules
         WHERE employee_id = e.id AND effective_from <= CURDATE()
           AND (effective_to IS NULL OR effective_to >= CURDATE())
         ORDER BY effective_from DESC, id DESC LIMIT 1)
  LEFT JOIN locations l ON l.id = es.location_id
 WHERE e.is_active = TRUE AND e.role = ''employee''
 ORDER BY e.emp_id');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- 3. HAS THE WATCHDOG EVER RUN? -----------------------------------------------
-- The geofence auto clock-out runs ONLY when something POSTs to
-- /api/cron/live-tracking-monitor. It is NOT part of the in-app scheduler, and
-- that endpoint rejects every request unless CRON_SECRET is set. Zero here with
-- a healthy section 1 and 2 means nothing is calling it.
SELECT 'geofence auto clock-outs ever' AS check_name,
       COUNT(*) AS total, MAX(created_at) AS most_recent
  FROM audit_log
 WHERE action = 'session_auto_closed'
   AND JSON_EXTRACT(details, '$.reason') IN ('left_the_fence', 'presence_never_confirmed');


-- 4. ARE PHONES REPORTING? ----------------------------------------------------
-- No pings while people are clocked in means the tracking service is not
-- running: the toggle in section 2, background-location permission not set to
-- "Allow all the time", or battery optimisation killing it.
SELECT 'location pings in the last hour' AS check_name,
       COUNT(*) AS points,
       COUNT(DISTINCT lts.employee_id) AS phones_reporting,
       MAX(ltp.tracked_at_utc) AS most_recent_utc
  FROM live_tracking_points ltp
  JOIN live_tracking_sessions lts ON lts.id = ltp.session_id
 WHERE ltp.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR);
