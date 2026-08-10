-- =============================================================================
-- TURN FEATURES ON FOR AN EMPLOYEE
--
--   mysql -u <user> -p <database> < database/employee_switches.sql
--
-- These three switches decide whether the features work at all. They are also
-- editable from the admin UI (Employees -> edit), but SQL is the way in while
-- nobody can sign in to the web app.
--
--   allow_multiple_sessions  Several clock-ins in one day. When OFF, the phone
--                            shows "Attendance completed for today" after the
--                            first clock-out and offers no way back in.
--
--   live_tracking_enabled    Location reporting. When OFF, the phone stops
--                            tracking AND the away-from-site watchdog ignores
--                            the employee entirely (their phone is not meant to
--                            report, so silence is not held against them).
--
--   work_mode                'on_site' is required for geofence auto clock-out.
--                            'off_site' staff clock in from anywhere.
-- =============================================================================

-- The tables are utf8mb4_unicode_ci, but the mysql CLI on MySQL 8 connects as
-- utf8mb4_0900_ai_ci — and comparing a user variable against a column across
-- those two collations is an error, not a silent coercion. Pin the connection
-- to the tables' collation so @variables match. (The app's own driver already
-- negotiates utf8mb4_unicode_ci, which is why this only bites from the CLI.)
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;


SET @who := 'reena';   -- <<< name or emp_id, partial match


-- 1. BEFORE -------------------------------------------------------------------
SELECT e.emp_id, e.name,
       IF(e.allow_multiple_sessions,'on','OFF') AS multi_login,
       IF(e.live_tracking_enabled,'on','OFF')   AS tracking,
       e.work_mode,
       COALESCE(l.name,'NO LOCATION')           AS work_location,
       IF(es.geofencing_enabled,'on','OFF')     AS geofence
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%');


-- 2. APPLY --------------------------------------------------------------------
-- Comment out any line you do NOT want to change.
UPDATE employees e
SET
  e.allow_multiple_sessions = TRUE,      -- several clock-ins per day
  e.live_tracking_enabled   = TRUE,      -- location reporting
  e.work_mode               = 'on_site'  -- required for the geofence
WHERE e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%');


-- 3. THE FENCE ----------------------------------------------------------------
-- Auto clock-out for leaving the site ALSO needs a location on the schedule and
-- geofencing switched on. Geofencing with no location fences nothing, so the
-- app refuses that combination — set both together.
--
-- Uncomment and set the location name to apply it:
--
-- UPDATE employee_schedules es
--   JOIN employees e  ON e.id = es.employee_id
--   JOIN locations l  ON l.name = 'Client Site A'   -- <<< the site they work at
-- SET es.location_id = l.id, es.geofencing_enabled = TRUE
-- WHERE (e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
--   AND es.effective_from <= CURDATE()
--   AND (es.effective_to IS NULL OR es.effective_to >= CURDATE());


-- 4. AFTER --------------------------------------------------------------------
SELECT e.emp_id, e.name,
       IF(e.allow_multiple_sessions,'on','OFF') AS multi_login,
       IF(e.live_tracking_enabled,'on','OFF')   AS tracking,
       e.work_mode,
       COALESCE(l.name,'NO LOCATION')           AS work_location,
       IF(es.geofencing_enabled,'on','OFF')     AS geofence
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%');

-- The employee must sign out and back in on the phone for the change to take
-- effect — the app reads these once when the dashboard loads.
