-- =============================================================================
-- WHY WAS THIS PERSON NOT AUTO CLOCKED-OUT?
--
--   mysql -u <user> -p <database> < database/why_no_auto_logout.sql
--
-- This mirrors the away-from-site watchdog's own conditions, one column per
-- condition, for everyone who is clocked in right now. The watchdog acts only
-- when EVERY gate says yes. One 'NO' is the whole answer.
--
-- The gates come from runGeofenceWatchdog() in lib/liveTrackingMonitor.ts:
--
--   employees.is_active              = TRUE
--   employees.work_mode              = 'on_site'
--   employees.live_tracking_enabled  = TRUE
--   employee_schedules.geofencing_enabled = TRUE   <-- most often the one
--   employee_schedules.location_id   -> an ACTIVE location
--   attendance: clocked in, not clocked out, and in for longer than the grace
--   no approved on-duty covering right now
-- =============================================================================

SET @grace_min := 30;   -- GEOFENCE_PRESENCE_GRACE_MIN on the server

SELECT
  e.emp_id,
  e.name,

  IF(e.is_active = 1, 'yes', 'NO')                                   AS active,
  IF(e.work_mode = 'on_site', 'yes',
     CONCAT('NO (', COALESCE(e.work_mode,'unset'), ')'))             AS on_site,
  IF(e.live_tracking_enabled = 1, 'yes', 'NO')                       AS tracking_on,
  IF(es.id IS NULL, 'NO SCHEDULE',
     IF(es.geofencing_enabled = 1, 'yes', 'NO'))                     AS geofence_on,
  IF(es.location_id IS NULL, 'NO LOCATION',
     IF(l.is_active = 1, l.name, CONCAT('NO (', l.name, ' inactive)'))) AS location,

  -- How long they have been clocked in. Below the grace period the watchdog
  -- deliberately leaves them alone, however far away they are.
  TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP())             AS clocked_in_min,
  IF(TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP()) >= @grace_min,
     'yes', CONCAT('not yet (', @grace_min, ' min)'))                AS past_grace,

  -- Minutes since a fix last placed them INSIDE the fence. NULL means no fix
  -- ever has — the 'presence never confirmed' case, which still ends the day.
  (SELECT TIMESTAMPDIFF(MINUTE, MAX(p.tracked_at_utc), UTC_TIMESTAMP())
     FROM live_tracking_points p
    WHERE p.employee_id = e.id
      AND p.tracked_at_utc >= a.clock_in_utc
      AND (6371000 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(p.latitude - l.latitude)/2), 2) +
            COS(RADIANS(l.latitude)) * COS(RADIANS(p.latitude)) *
            POWER(SIN(RADIANS(p.longitude - l.longitude)/2), 2)
          ))) <= GREATEST(COALESCE(l.radius_meters,100), 200)
                 + LEAST(COALESCE(p.accuracy_meters,0), 500))        AS min_since_inside,

  -- An approved on-duty request means being away is expected, and the watchdog
  -- deliberately leaves them clocked in.
  IF(EXISTS (SELECT 1 FROM permission_requests pr
              WHERE pr.employee_id = e.id
                AND pr.status = 'approved'
                AND pr.request_type = 'on_duty'
                AND pr.permission_date = DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'))
                AND TIME(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'))
                    BETWEEN pr.start_time AND pr.end_time),
     'ON DUTY - left alone on purpose', 'no')                        AS on_duty,

  -- The verdict, by the same rules the watchdog applies.
  CASE
    WHEN e.is_active <> 1                       THEN 'skipped: inactive'
    WHEN e.work_mode <> 'on_site'               THEN 'skipped: not on_site'
    WHEN e.live_tracking_enabled <> 1           THEN 'skipped: tracking off'
    WHEN es.id IS NULL                          THEN 'skipped: no schedule'
    WHEN es.geofencing_enabled <> 1             THEN 'skipped: geofencing OFF'
    WHEN es.location_id IS NULL                 THEN 'skipped: no location'
    WHEN l.is_active <> 1                       THEN 'skipped: location inactive'
    WHEN TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP()) < @grace_min
                                                THEN 'skipped: within grace'
    -- A fix has placed them INSIDE the fence recently, so their presence is
    -- vouched for and the watchdog rightly leaves them alone. Without this the
    -- report claimed people would be clocked out who never should be.
    WHEN (SELECT TIMESTAMPDIFF(MINUTE, MAX(p.tracked_at_utc), UTC_TIMESTAMP())
            FROM live_tracking_points p
           WHERE p.employee_id = e.id
             AND p.tracked_at_utc >= a.clock_in_utc
             AND (6371000 * 2 * ASIN(SQRT(
                   POWER(SIN(RADIANS(p.latitude - l.latitude)/2), 2) +
                   COS(RADIANS(l.latitude)) * COS(RADIANS(p.latitude)) *
                   POWER(SIN(RADIANS(p.longitude - l.longitude)/2), 2)
                 ))) <= GREATEST(COALESCE(l.radius_meters,100), 200)
                        + LEAST(COALESCE(p.accuracy_meters,0), 500)) < @grace_min
                                                THEN 'skipped: seen inside the fence recently'
    ELSE '>>> WOULD BE CLOCKED OUT'
  END                                                                AS verdict

FROM attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id
     AND effective_from <= a.work_date
     AND (effective_to IS NULL OR effective_to >= a.work_date)
   ORDER BY effective_from DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
WHERE a.clock_in_utc IS NOT NULL
  AND a.clock_out_utc IS NULL
ORDER BY verdict DESC, e.emp_id;


-- Nobody listed above at all? Then nobody is clocked in, and there is nothing
-- for the watchdog to act on.
SELECT COUNT(*) AS people_clocked_in_right_now
FROM attendance WHERE clock_in_utc IS NOT NULL AND clock_out_utc IS NULL;


-- Has the sweep run recently? It runs in-process every few minutes from the
-- app server (LIVE_MONITOR_INTERVAL_MIN). No rows here after several minutes of
-- uptime means the server is running code from BEFORE that change.
SELECT 'away-from-site clock-outs, last 24h' AS check_name,
       COUNT(*) AS total,
       MAX(created_at) AS most_recent_utc
FROM audit_log
WHERE action = 'geofence_auto_clockout'
  AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR);
