-- =============================================================================
-- Why is auto clock-out / tracking / location warnings not working?
--
-- Run against PRODUCTION:
--   mysql -u <user> -p <database> < database/diagnose_geofence.sql
--
-- Every gate below must pass for an employee. One 'NO' explains the silence.
-- =============================================================================

SELECT
  e.emp_id,
  e.name,

  -- GATE 1 — the server watchdog only ever looks at on-site staff.
  IF(e.work_mode = 'on_site', 'yes', CONCAT('NO (', COALESCE(e.work_mode,'unset'), ')'))
    AS on_site,

  -- GATE 2 — admin toggle. When off, the phone stops tracking AND the
  -- watchdog deliberately ignores them (their phone is not meant to report).
  -- This single switch disables auto clock-out, polling and the warnings.
  IF(e.live_tracking_enabled = 1, 'yes', 'NO')
    AS tracking_enabled,

  -- GATE 3 — a fence needs somewhere to measure from. With no location the
  -- phone never receives coordinates, so it cannot detect leaving the site.
  IF(es.location_id IS NOT NULL, l.name, 'NO LOCATION')
    AS work_location,

  -- GATE 4 — the fence switch itself. The watchdog requires this to be ON.
  IF(es.geofencing_enabled = 1, 'yes', 'NO')
    AS geofencing_on,

  -- GATE 5 — the location must still be active.
  IF(l.id IS NULL, 'n/a', IF(l.is_active = 1, 'yes', 'NO (deactivated)'))
    AS location_active,

  COALESCE(l.radius_meters, 0) AS radius_m,

  -- The verdict the watchdog itself would reach.
  IF(e.work_mode = 'on_site'
     AND e.live_tracking_enabled = 1
     AND es.location_id IS NOT NULL
     AND es.geofencing_enabled = 1
     AND l.is_active = 1,
     '>>> WATCHED', 'not watched') AS result

FROM employees e
LEFT JOIN employee_schedules es
  ON es.id = (
    SELECT id FROM employee_schedules
    WHERE employee_id = e.id
      AND effective_from <= CURDATE()
      AND (effective_to IS NULL OR effective_to >= CURDATE())
    ORDER BY effective_from DESC, id DESC
    LIMIT 1
  )
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
ORDER BY result DESC, e.emp_id;


-- Has the watchdog EVER run? It only runs when something POSTs to
-- /api/cron/live-tracking-monitor — it is NOT part of the in-app scheduler.
-- An empty result here means it has never fired, whatever the roster says.
SELECT 'geofence auto clock-outs ever recorded' AS check_name,
       COUNT(*) AS total,
       MAX(created_at) AS most_recent
FROM audit_log
WHERE action IN ('geofence_auto_clock_out', 'session_auto_closed')
  AND JSON_EXTRACT(details, '$.reason') IN ('left_the_fence', 'presence_never_confirmed');


-- Are phones reporting at all? No rows in the last hour means the tracking
-- service is not running on any device (permission, battery saver, or the
-- admin toggle above), which also explains missing location warnings.
SELECT 'location pings in the last hour' AS check_name,
       COUNT(*) AS points,
       COUNT(DISTINCT lts.employee_id) AS phones_reporting,
       MAX(ltp.tracked_at_utc) AS most_recent_utc
FROM live_tracking_points ltp
JOIN live_tracking_sessions lts ON lts.id = ltp.session_id
WHERE ltp.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR);


-- Who is clocked in right now, and when did their phone last report?
-- A large "silent_minutes" while clocked in is the phone not reporting.
SELECT e.emp_id, e.name,
       DATE_FORMAT(CONVERT_TZ(a.clock_in_utc,'+00:00','+05:30'), '%H:%i') AS clocked_in_ist,
       TIMESTAMPDIFF(MINUTE,
         (SELECT MAX(ltp.tracked_at_utc)
            FROM live_tracking_points ltp
            JOIN live_tracking_sessions lts ON lts.id = ltp.session_id
           WHERE lts.employee_id = e.id),
         UTC_TIMESTAMP()) AS silent_minutes
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.clock_out_utc IS NULL AND a.clock_in_utc IS NOT NULL
ORDER BY silent_minutes DESC;
