-- =============================================================================
-- "Clocked in 09:20, clocked out 09:20, 0h 0m, present"
--
--   mysql -u <user> -p <database> < database/zero_hour_clockouts.sql
--
-- Exactly one thing in this application writes a clock-out equal to the
-- clock-in: the geofence presence watchdog (lib/liveTrackingMonitor.ts).
--
-- The rule it enforces is that an on-site employee must keep PROVING they are
-- inside their fence. Once GEOFENCE_PRESENCE_GRACE_MIN (default 30) passes with
-- no location fix placing them inside, the day is closed and credited only up
-- to the last moment their presence was confirmed. When no fix EVER confirmed
-- it, that moment is the clock-in itself — so the day closes at the second it
-- opened, with zero hours.
--
-- The rule is doing what it was written to do. What it cannot tell apart is
--
--     "this person left the site"        (deliberate, and worth catching)
--     "this person's phone never reported at all"
--
-- and the second one costs an employee their whole day: zero hours, and — since
-- the row now has a clock-out — no way to clock in again, because the day reads
-- as completed.
--
-- Sections 1-3 establish which is happening. Section 4 stops it. Section 5
-- gives today back to the people it took it from.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @today := DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') - INTERVAL 7 HOUR);
SELECT @today AS current_work_date;


-- -----------------------------------------------------------------------------
-- 1. The days closed this way, and WHY — straight from the audit log.
--
--    reason = 'presence_never_confirmed'  → not one fix ever landed inside the
--                                           fence. The phone is not reporting.
--    reason = 'left_the_fence'            → fixes arrived, then stopped or moved
--                                           outside. This is the rule working.
--
--    If the first reason dominates, the fences are punishing a tracking problem,
--    not catching absence.
-- -----------------------------------------------------------------------------
SELECT DATE(CONVERT_TZ(al.created_at, '+00:00', '+05:30'))            AS day_ist,
       JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.emp_id'))             AS emp_id,
       JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.reason'))             AS reason,
       JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.location'))           AS site,
       JSON_EXTRACT(al.details, '$.fence_radius_m')                   AS fence_m,
       JSON_EXTRACT(al.details, '$.presence_grace_min')               AS grace_min,
       JSON_EXTRACT(al.details, '$.minutes_unconfirmed')              AS min_unconfirmed,
       CONVERT_TZ(al.created_at, '+00:00', '+05:30')                  AS closed_at_ist
FROM audit_log al
WHERE al.action = 'geofence_auto_clockout'
  AND al.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY)
ORDER BY al.created_at DESC;


-- -----------------------------------------------------------------------------
-- 2. Today's zero-hour days, as the admin table shows them.
-- -----------------------------------------------------------------------------
SELECT e.emp_id,
       e.name,
       CONVERT_TZ(a.clock_in_utc,  '+00:00', '+05:30') AS clock_in_ist,
       CONVERT_TZ(a.clock_out_utc, '+00:00', '+05:30') AS clock_out_ist,
       a.total_minutes,
       a.status,
       a.geofence_status,
       a.id AS attendance_id
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.work_date = @today
  AND a.clock_out_utc IS NOT NULL
  AND COALESCE(a.total_minutes, 0) <= 2
ORDER BY a.clock_in_utc ASC;


-- -----------------------------------------------------------------------------
-- 3. Are the phones reporting at all?
--
--    A tracked employee with zero points today has not sent a single fix. That
--    is a phone-side problem — background location permission ("Allow all the
--    time"), battery optimisation killing the task, or the app unable to reach
--    the server — and no fence setting will fix it.
-- -----------------------------------------------------------------------------
SELECT e.emp_id,
       e.name,
       es.geofencing_enabled,
       e.live_tracking_enabled,
       l.name                                              AS site,
       l.radius_meters                                     AS fence_m,
       COUNT(ltp.id)                                       AS fixes_today,
       CONVERT_TZ(MAX(ltp.tracked_at_utc), '+00:00', '+05:30') AS last_fix_ist
FROM employees e
LEFT JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= @today
  AND (es.effective_to IS NULL OR es.effective_to >= @today)
LEFT JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
LEFT JOIN live_tracking_points ltp ON ltp.employee_id = e.id
  AND ltp.tracked_at_utc >= CONVERT_TZ(@today + INTERVAL 7 HOUR, '+05:30', '+00:00')
WHERE e.is_active = TRUE
GROUP BY e.id, e.emp_id, e.name, es.geofencing_enabled, e.live_tracking_enabled,
         l.name, l.radius_meters
ORDER BY fixes_today ASC, e.name ASC;


-- -----------------------------------------------------------------------------
-- 4. STOP IT — disarm the fences until the phones are proven to report.
--
--    The watchdog only ever looks at schedules with geofencing_enabled = TRUE.
--    With this off it does nothing at all, and everyone's day runs normally.
--    Re-arm from database/enable_auto_logout.sql once section 3 shows fixes
--    arriving for everyone.
--
--    Uncomment to run.
-- -----------------------------------------------------------------------------
-- UPDATE employee_schedules SET geofencing_enabled = FALSE
--  WHERE geofencing_enabled = TRUE;


-- -----------------------------------------------------------------------------
-- 5. GIVE TODAY BACK — reopen the days that were closed at zero.
--
--    Clearing the clock-out puts each person back where they were: still
--    clocked in, hours counting from their real arrival. Run section 4 FIRST,
--    or the watchdog will close them again within the grace period.
--
--    Only rows the watchdog itself closed are touched, and only today's, so a
--    genuine short visit recorded by hand is left alone.
--
--    Uncomment to run.
-- -----------------------------------------------------------------------------
-- UPDATE attendance a
--   JOIN audit_log al
--     ON al.action = 'geofence_auto_clockout'
--    AND al.entity = 'attendance'
--    AND al.entity_id = a.id
--    SET a.clock_out_utc = NULL,
--        a.clock_out_lat = NULL,
--        a.clock_out_lng = NULL,
--        a.total_minutes = NULL
--  WHERE a.work_date = @today
--    AND a.clock_out_utc IS NOT NULL
--    AND COALESCE(a.total_minutes, 0) = 0;
