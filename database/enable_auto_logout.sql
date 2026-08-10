-- =============================================================================
-- TURN AUTO LOGOUT ON
--
--   mysql --table -u <user> -p <database> < database/enable_auto_logout.sql
--
-- Away-from-site auto clock-out needs FOUR things per employee:
--
--   employees.work_mode             = 'on_site'
--   employees.live_tracking_enabled = TRUE
--   employee_schedules.location_id  -> an active location   (cannot be guessed)
--   employee_schedules.geofencing_enabled = TRUE
--
-- ...and one thing this script cannot set: a phone that actually reports.
--
-- THIS RUNS AS A DRY RUN BY DEFAULT. It shows you exactly who would be armed
-- and who would be skipped, and changes nothing until you set @dry_run := 0.
--
-- WHY THE DRY RUN EXISTS
-- The previous version armed everyone who had a work location, regardless of
-- whether their phone had ever sent a fix. Silence is treated as absence — that
-- is deliberate, it is what stops someone force-stopping the app and being paid
-- for the afternoon — so arming a dead phone does not fail safely. It closes
-- that person's day at their last confirmed presence and they lose real hours
-- they actually worked. Running it unfiltered would have taken about seven
-- hours each off six people whose phones were not reporting.
--
-- So this version refuses to arm anyone whose phone has not been heard from,
-- and lists them for you to chase instead.
-- =============================================================================

-- The tables are utf8mb4_unicode_ci, but the mysql CLI on MySQL 8 connects as
-- utf8mb4_0900_ai_ci — and comparing a user variable against a column across
-- those two collations is an error, not a silent coercion. Pin the connection
-- to the tables' collation so @variables match. (The app's own driver already
-- negotiates utf8mb4_unicode_ci, which is why this only bites from the CLI.)
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;


SET @dry_run := 1;   -- <<< 1 = show me what would happen; 0 = actually do it

-- Narrow to ONE person (partial match on name or emp_id), or leave EMPTY for all.
SET @who := '';      -- <<< e.g. 'RACE013' or 'reena', or '' for everybody

-- How recently a phone must have reported before we trust a fence on it.
SET @min_ping_hours := 48;

-- Convert people currently marked off-site into on_site staff? Leave at 0.
-- Field staff are marked off-site on purpose; fencing them to a base location
-- would end their day the moment they drove to a customer.
SET @include_field_staff := 0;

-- Warn about fences tighter than this. GPS on a phone indoors drifts by tens of
-- metres, so a very small radius produces clock-outs for people sitting at
-- their desk.
SET @tight_fence_m := 30;


-- 0. READINESS ----------------------------------------------------------------
-- Read this table BEFORE you set @dry_run := 0. It is the whole decision.
SELECT
  e.emp_id,
  e.name,
  COALESCE(e.work_mode, 'unset')                                   AS work_mode,
  COALESCE(l.name, '— none —')                                     AS site,
  l.radius_meters                                                  AS fence_m,
  COALESCE(CONCAT(TIMESTAMPDIFF(HOUR, lp.last_ping, UTC_TIMESTAMP()), ' h ago'),
           'NEVER')                                                AS phone_last_reported,
  CASE
    WHEN es.id IS NULL            THEN 'skip: no schedule'
    WHEN es.location_id IS NULL   THEN 'skip: no work location — assign one'
    WHEN l.is_active <> 1         THEN 'skip: location is deactivated'
    WHEN e.work_mode <> 'on_site' AND @include_field_staff = 0
                                  THEN 'skip: off-site staff, left alone'
    WHEN lp.last_ping IS NULL     THEN 'SKIP: phone has NEVER reported'
    WHEN lp.last_ping < DATE_SUB(UTC_TIMESTAMP(), INTERVAL @min_ping_hours HOUR)
                                  THEN 'SKIP: phone silent too long'
    WHEN es.geofencing_enabled = 1 AND e.live_tracking_enabled = 1
                                  THEN 'already armed'
    ELSE '>>> WILL BE ARMED'
  END                                                              AS outcome,
  IF(l.radius_meters IS NOT NULL AND l.radius_meters < @tight_fence_m,
     CONCAT('tight fence (', l.radius_meters, 'm) — expect false clock-outs'),
     '')                                                           AS warning
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
LEFT JOIN (
  SELECT employee_id, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY employee_id
) lp ON lp.employee_id = e.id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
ORDER BY outcome DESC, e.emp_id;


-- 1. BEFORE -------------------------------------------------------------------
SELECT IF(@dry_run = 1, 'DRY RUN — nothing will be changed', 'APPLYING CHANGES') AS mode;

-- DISTINCT: an employee with two overlapping current schedule rows would
-- otherwise be counted twice, and the total would disagree with the readiness
-- table above, which takes only their latest schedule.
SELECT COUNT(DISTINCT e.id) AS employees_with_auto_logout_working_BEFORE
FROM employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND e.work_mode = 'on_site'
  AND e.live_tracking_enabled = TRUE
  AND es.geofencing_enabled = TRUE;


-- 2. THE EMPLOYEE-LEVEL SWITCHES ----------------------------------------------
-- Only for staff with a real work site AND a phone that has been heard from.
UPDATE employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
SET e.work_mode = 'on_site',
    e.live_tracking_enabled = TRUE
WHERE @dry_run = 0
  AND e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site')
  AND EXISTS (SELECT 1 FROM live_tracking_points p
               WHERE p.employee_id = e.id
                 AND p.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @min_ping_hours HOUR));


-- 3. THE FENCE ITSELF ---------------------------------------------------------
-- The flag that is almost always the blocker: a location is assigned but
-- geofencing was never ticked, so nothing is ever enforced.
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
SET es.geofencing_enabled = TRUE
WHERE @dry_run = 0
  AND e.is_active = TRUE
  AND e.role = 'employee'
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site')
  AND EXISTS (SELECT 1 FROM live_tracking_points p
               WHERE p.employee_id = e.id
                 AND p.tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @min_ping_hours HOUR));


-- 4. AFTER --------------------------------------------------------------------
-- DISTINCT: an employee with two overlapping current schedule rows would
-- otherwise be counted twice, and the total would disagree with the readiness
-- table above, which takes only their latest schedule.
SELECT COUNT(DISTINCT e.id) AS employees_with_auto_logout_working_AFTER
FROM employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND e.work_mode = 'on_site'
  AND e.live_tracking_enabled = TRUE
  AND es.geofencing_enabled = TRUE;


-- 5. THE PHONES TO CHASE ------------------------------------------------------
-- Everyone deliberately left unarmed because their phone is not reporting.
-- Each of these needs, on the handset itself: APK v1.4.1 or later, location
-- permission set to "Allow all the time" (not "While using the app"), and
-- battery optimisation turned OFF for the app. Then they appear here no longer
-- and you can re-run this script to arm them.
SELECT e.emp_id, e.name,
       COALESCE(l.name, '— no site —') AS site,
       COALESCE(CONCAT(TIMESTAMPDIFF(HOUR, lp.last_ping, UTC_TIMESTAMP()), ' h ago'),
                'NEVER') AS phone_last_reported
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
LEFT JOIN (
  SELECT employee_id, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY employee_id
) lp ON lp.employee_id = e.id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND es.location_id IS NOT NULL
  AND l.id IS NOT NULL
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site')
  AND (lp.last_ping IS NULL
       OR lp.last_ping < DATE_SUB(UTC_TIMESTAMP(), INTERVAL @min_ping_hours HOUR))
ORDER BY lp.last_ping IS NOT NULL, lp.last_ping DESC, e.emp_id;


-- 6. WHO IS STILL NOT COVERED, AND WHY ----------------------------------------
SELECT e.emp_id, e.name,
       CASE
         WHEN es.id IS NULL            THEN 'no schedule at all'
         WHEN es.location_id IS NULL   THEN 'NO WORK LOCATION — assign one'
         WHEN l.is_active <> 1         THEN 'location is deactivated'
         WHEN e.work_mode <> 'on_site' THEN 'off-site staff — left alone on purpose'
         WHEN lp.last_ping IS NULL
           OR lp.last_ping < DATE_SUB(UTC_TIMESTAMP(), INTERVAL @min_ping_hours HOUR)
                                       THEN 'phone not reporting — see the list above'
         -- Ready in every respect, just not switched on yet. During a dry run
         -- this is where everyone who is about to be armed appears; calling
         -- them "not reporting" was wrong and read as a fault when it was not.
         WHEN @dry_run = 1             THEN 'ready — set @dry_run := 0 to arm them'
         ELSE 'geofencing flag not set — re-run this script'
       END AS why_not
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
LEFT JOIN (
  SELECT employee_id, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY employee_id
) lp ON lp.employee_id = e.id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND NOT (es.location_id IS NOT NULL AND l.is_active = 1
           AND e.work_mode = 'on_site' AND es.geofencing_enabled = 1)
ORDER BY why_not, e.emp_id;


-- 7. FENCES THAT ARE TOO TIGHT ------------------------------------------------
-- A phone's GPS drifts by tens of metres indoors. A fence smaller than that
-- clocks people out while they are sitting at their desk, and they will blame
-- the app rather than the radius. 50-100 m is a sensible office fence.
SELECT id, name, radius_meters,
       CONCAT('widen to at least ', @tight_fence_m, 'm') AS advice
FROM locations
WHERE is_active = TRUE AND radius_meters < @tight_fence_m
ORDER BY radius_meters;


-- Auto clock-out then happens within GEOFENCE_PRESENCE_GRACE_MIN minutes of an
-- employee's presence no longer being confirmed inside their fence. The server
-- sweep runs every LIVE_MONITOR_INTERVAL_MIN minutes.
--
-- To undo everything this did, for one person or for all:
--   UPDATE employee_schedules es JOIN employees e ON e.id = es.employee_id
--      SET es.geofencing_enabled = FALSE
--    WHERE e.emp_id = 'RACE013';   -- or drop the WHERE for everybody
