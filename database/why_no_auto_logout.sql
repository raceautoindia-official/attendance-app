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
--   and no location fix has placed them inside the fence for the grace period
--
-- The three settings below MUST match the server's .env, or this report will
-- disagree with the watchdog and send you looking for a fault that isn't there.
-- It has done exactly that once: it assumed a 200 m minimum fence long after
-- the floor was removed, so for a 50 m site it called someone 700 m away
-- "inside" while the watchdog was correctly ending their day.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @grace_min := 10;   -- GEOFENCE_PRESENCE_GRACE_MIN
SET @min_fence := 0;    -- MIN_FENCE_RADIUS_M   (0 = each site's own radius, no floor)
SET @max_acc   := 500;  -- MAX_ACCURACY_ALLOWANCE_M

-- The fence a fix is measured against, exactly as the code computes it:
--   fence     = MAX(the site's radius, @min_fence)
--   allowance = MIN(the fix's own accuracy, MIN(@max_acc, fence))
-- Capping the allowance at the fence itself is what stops a wildly imprecise
-- fix from vouching for someone who is nowhere near the site.

WITH open_sessions AS (
  SELECT
    a.id AS attendance_id, a.employee_id, a.clock_in_utc, a.work_date,
    e.emp_id, e.name, e.is_active, e.work_mode, e.live_tracking_enabled,
    es.id AS sched_id, es.geofencing_enabled, es.location_id,
    l.name AS loc_name, l.is_active AS loc_active,
    l.latitude AS loc_lat, l.longitude AS loc_lng, l.radius_meters,
    GREATEST(COALESCE(l.radius_meters, 100), @min_fence) AS fence
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
),
presence AS (
  SELECT os.*,
    -- Last moment a fix placed them INSIDE. NULL means not once since clock-in,
    -- which the watchdog treats as 'presence_never_confirmed' and still acts on.
    (SELECT MAX(p.tracked_at_utc)
       FROM live_tracking_points p
      WHERE p.employee_id = os.employee_id
        AND p.tracked_at_utc >= os.clock_in_utc
        AND (6371000 * 2 * ASIN(SQRT(
              POWER(SIN(RADIANS(p.latitude  - os.loc_lat) / 2), 2) +
              COS(RADIANS(os.loc_lat)) * COS(RADIANS(p.latitude)) *
              POWER(SIN(RADIANS(p.longitude - os.loc_lng) / 2), 2))))
            <= os.fence + LEAST(COALESCE(p.accuracy_meters, 0),
                                LEAST(@max_acc, os.fence))
    ) AS last_inside_utc,
    -- The most recent fix of any kind, and how far out it was. This is what
    -- tells you whether the phone is reporting at all, and from where.
    (SELECT p2.tracked_at_utc FROM live_tracking_points p2
      WHERE p2.employee_id = os.employee_id
      ORDER BY p2.tracked_at_utc DESC LIMIT 1) AS last_ping_utc,
    (SELECT ROUND(6371000 * 2 * ASIN(SQRT(
              POWER(SIN(RADIANS(p3.latitude  - os.loc_lat) / 2), 2) +
              COS(RADIANS(os.loc_lat)) * COS(RADIANS(p3.latitude)) *
              POWER(SIN(RADIANS(p3.longitude - os.loc_lng) / 2), 2))))
       FROM live_tracking_points p3
      WHERE p3.employee_id = os.employee_id
      ORDER BY p3.tracked_at_utc DESC LIMIT 1) AS last_ping_m
  FROM open_sessions os
)
SELECT
  emp_id,
  name,

  IF(is_active = 1, 'yes', 'NO')                                     AS active,
  IF(work_mode = 'on_site', 'yes',
     CONCAT('NO (', COALESCE(work_mode, 'unset'), ')'))              AS on_site,
  IF(live_tracking_enabled = 1, 'yes', 'NO')                         AS tracking_on,
  IF(sched_id IS NULL, 'NO SCHEDULE',
     IF(geofencing_enabled = 1, 'yes', 'NO'))                        AS geofence_on,
  IF(location_id IS NULL, 'NO LOCATION',
     IF(loc_active = 1, CONCAT(loc_name, ' (', fence, 'm)'),
        CONCAT('NO (', loc_name, ' inactive)')))                     AS location,

  TIMESTAMPDIFF(MINUTE, clock_in_utc, UTC_TIMESTAMP())               AS clocked_in_min,

  -- Is the phone reporting at all, and from how far out?
  COALESCE(CONCAT(TIMESTAMPDIFF(MINUTE, last_ping_utc, UTC_TIMESTAMP()), ' min ago'),
           'NEVER')                                                  AS last_ping,
  last_ping_m                                                        AS last_ping_metres,

  -- Minutes since a fix last vouched for them. This is the number the watchdog
  -- actually compares against the grace period. It counts from clock-in when no
  -- fix has ever placed them inside.
  TIMESTAMPDIFF(MINUTE, COALESCE(last_inside_utc, clock_in_utc), UTC_TIMESTAMP())
                                                                     AS min_unconfirmed,
  IF(last_inside_utc IS NULL, 'never since clock-in', 'yes')         AS seen_inside,

  IF(EXISTS (SELECT 1 FROM permission_requests pr
              WHERE pr.employee_id = presence.employee_id
                AND pr.status = 'approved'
                AND pr.request_type = 'on_duty'
                AND pr.permission_date = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                AND TIME(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                    BETWEEN pr.start_time AND pr.end_time),
     'ON DUTY - left alone on purpose', 'no')                        AS on_duty,

  -- The verdict, by the same gates in the same order as the watchdog.
  CASE
    WHEN is_active <> 1                      THEN 'skipped: inactive'
    WHEN work_mode <> 'on_site'              THEN 'skipped: not on_site'
    WHEN live_tracking_enabled <> 1          THEN 'skipped: tracking off'
    WHEN sched_id IS NULL                    THEN 'skipped: no schedule'
    WHEN geofencing_enabled <> 1             THEN 'skipped: geofencing OFF'
    WHEN location_id IS NULL                 THEN 'skipped: no location'
    WHEN loc_active <> 1                     THEN 'skipped: location inactive'
    -- The watchdog will not even look at a session younger than the grace.
    WHEN TIMESTAMPDIFF(MINUTE, clock_in_utc, UTC_TIMESTAMP()) < @grace_min
                                             THEN 'skipped: within grace'
    WHEN EXISTS (SELECT 1 FROM permission_requests pr
                  WHERE pr.employee_id = presence.employee_id
                    AND pr.status = 'approved'
                    AND pr.request_type = 'on_duty'
                    AND pr.permission_date = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                    AND TIME(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                        BETWEEN pr.start_time AND pr.end_time)
                                             THEN 'skipped: approved on-duty'
    -- A fix has vouched for them recently, so the watchdog rightly leaves them
    -- alone. Without this the report claimed people would be clocked out who
    -- never should be.
    WHEN TIMESTAMPDIFF(MINUTE, COALESCE(last_inside_utc, clock_in_utc), UTC_TIMESTAMP())
           < @grace_min                      THEN 'skipped: seen inside the fence recently'
    ELSE '>>> WOULD BE CLOCKED OUT'
  END                                                                AS verdict

FROM presence
ORDER BY verdict DESC, emp_id;


-- Nobody listed above at all? Then nobody is clocked in, and there is nothing
-- for the watchdog to act on.
SELECT COUNT(*) AS people_clocked_in_right_now
FROM attendance WHERE clock_in_utc IS NOT NULL AND clock_out_utc IS NULL;


-- Has the sweep ever acted? It runs in-process every LIVE_MONITOR_INTERVAL_MIN
-- minutes from the app server. No rows here after several minutes of uptime
-- means either nobody has left a fence, or the server is running code from
-- before the in-process scheduler existed.
SELECT 'away-from-site clock-outs, last 24h' AS check_name,
       COUNT(*) AS total,
       MAX(created_at) AS most_recent_utc
FROM audit_log
WHERE action = 'geofence_auto_clockout'
  AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR);


-- The most recent auto clock-outs in full, including the fence and the gap that
-- triggered each one. Check fence_radius_m here against the site's radius: if
-- they differ, this report's @min_fence does not match the server's.
SELECT created_at AS at_utc,
       JSON_UNQUOTE(JSON_EXTRACT(details, '$.emp_id'))              AS emp_id,
       JSON_UNQUOTE(JSON_EXTRACT(details, '$.reason'))              AS reason,
       JSON_EXTRACT(details, '$.fence_radius_m')                    AS fence_radius_m,
       JSON_EXTRACT(details, '$.presence_grace_min')                AS grace_min,
       JSON_EXTRACT(details, '$.minutes_unconfirmed')               AS min_unconfirmed
FROM audit_log
WHERE action = 'geofence_auto_clockout'
ORDER BY created_at DESC
LIMIT 10;
