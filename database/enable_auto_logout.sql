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
-- ...and one thing this script cannot set: a phone that reports CONTINUOUSLY.
--
-- THIS RUNS AS A DRY RUN BY DEFAULT. It shows you exactly who would be armed,
-- disarmed and skipped, and changes nothing until you set @dry_run := 0.
--
-- WHY THE GATE IS ABOUT RATE, NOT RECENCY
-- The first version armed anyone with a work location. The second only armed
-- phones "heard from in the last 48 hours" — and that is how a real morning was
-- destroyed: an employee whose phone had sent ONE fix passed the check, was
-- armed, and had her day closed back at the moment she clocked in, credited
-- zero minutes. Three people were zeroed that way in one morning, another three
-- lost most of it.
--
-- Silence is treated as absence on purpose — it is what stops someone
-- force-stopping the app and being paid for the afternoon. So a fence on a
-- phone that reports intermittently does not fail safe; it converts a full
-- working day into nothing.
--
-- The app sends a fix every 30 seconds with distanceInterval 0, as a keep-alive
-- that continues even when the employee is sitting still (LOCATION_INTERVAL_MS
-- in mobile/src/config.ts; halved from 15s when the whole fleet reported
-- battery drain). A healthy phone therefore produces about 720 points in 6
-- hours. The gate below asks for a fraction of that, which is generous about
-- Android doze but still tells a configured handset apart from one that sent a
-- single ping and went to sleep.
-- =============================================================================

-- The tables are utf8mb4_unicode_ci, but the mysql CLI on MySQL 8 connects as
-- utf8mb4_0900_ai_ci — and comparing a user variable against a column across
-- those two collations is an error, not a silent coercion. Pin the connection
-- to the tables' collation so @variables match. (The app's own driver already
-- negotiates utf8mb4_unicode_ci, which is why this only bites from the CLI.)
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;


SET @dry_run := 1;   -- <<< 1 = show me what would happen; 0 = actually do it

-- Narrow to ONE person (partial match on name or emp_id), or leave EMPTY for all.
-- Arming one person at a time, and watching them for a day, is the safe way to
-- roll this out. Arming everyone at once is what caused the damage above.
SET @who := '';      -- <<< e.g. 'RACE016' or 'balamurugan', or '' for everybody

-- WHAT COUNTS AS A PHONE THAT REPORTS.
-- Healthy is ~720 points per 6 hours. 150 is roughly one fix every 2.4 minutes
-- — a fifth of the expected rate, so doze and a patchy signal are forgiven,
-- while a phone that managed 1, 3 or 5 points is not.
SET @density_window_h      := 6;
SET @min_points_in_window  := 150;
SET @max_ping_age_min      := 15;

-- Convert people currently marked off-site into on_site staff? Leave at 0.
-- Field staff are marked off-site on purpose; fencing them to a base location
-- would end their day the moment they drove to a customer.
SET @include_field_staff := 0;

-- Warn about fences tighter than this. GPS on a phone indoors drifts by tens of
-- metres, so a very small radius produces clock-outs for people at their desk.
SET @tight_fence_m := 30;

-- Switch the fence back OFF for anyone already armed whose phone has stopped
-- reporting properly. Refusing to arm a bad phone is not enough on its own:
-- someone armed while their handset was healthy stays armed after it dies, and
-- keeps losing hours. Set to 0 only if you would rather decide those by hand.
SET @disarm_silent := 1;


-- 0. WHOSE PHONE ACTUALLY REPORTS ---------------------------------------------
-- Worked out once, then used by every section below, so the report and the
-- updates cannot disagree about who is healthy — they did once, and the
-- readiness table said "left alone" about people who were being clocked out.
DROP TEMPORARY TABLE IF EXISTS healthy_phones;
CREATE TEMPORARY TABLE healthy_phones (
  employee_id INT PRIMARY KEY,
  points      INT NOT NULL,
  last_ping   DATETIME NOT NULL
);
INSERT INTO healthy_phones (employee_id, points, last_ping)
SELECT employee_id, COUNT(*), MAX(tracked_at_utc)
FROM live_tracking_points
WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @density_window_h HOUR)
GROUP BY employee_id
HAVING COUNT(*) >= @min_points_in_window
   AND MAX(tracked_at_utc) >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @max_ping_age_min MINUTE);


-- 1. READINESS ----------------------------------------------------------------
-- Read this table BEFORE you set @dry_run := 0. It is the whole decision.
-- points_in_window is the number that matters: compare it against ~720.
SELECT
  e.emp_id,
  e.name,
  COALESCE(e.work_mode, 'unset')                                   AS work_mode,
  COALESCE(l.name, '— none —')                                     AS site,
  l.radius_meters                                                  AS fence_m,
  COALESCE(pts.n, 0)                                               AS points_in_window,
  COALESCE(CONCAT(TIMESTAMPDIFF(MINUTE, pts.last_ping, UTC_TIMESTAMP()), ' min ago'),
           'NEVER')                                                AS last_ping,
  CASE
    WHEN es.id IS NULL            THEN 'skip: no schedule'
    WHEN es.location_id IS NULL   THEN 'skip: no work location — assign one'
    WHEN l.is_active <> 1         THEN 'skip: location is deactivated'
    WHEN e.work_mode <> 'on_site' AND @include_field_staff = 0
                                  THEN 'skip: off-site staff, left alone'
    -- ARMED ALREADY, AND THE PHONE IS NOT REPORTING. Tested before the plain
    -- skip branches or it hides inside them, reading as "we left them alone"
    -- when the fence is live and zeroing their day every morning.
    WHEN es.geofencing_enabled = 1 AND e.live_tracking_enabled = 1 AND h.employee_id IS NULL
                                  THEN IF(@disarm_silent = 1,
                                          '<<< ARMED ON A BAD PHONE — will be DISARMED',
                                          '!!! ARMED ON A BAD PHONE — losing hours now')
    WHEN h.employee_id IS NULL AND COALESCE(pts.n, 0) = 0
                                  THEN 'SKIP: phone sends nothing'
    WHEN h.employee_id IS NULL    THEN CONCAT('SKIP: phone too patchy (', COALESCE(pts.n,0),
                                              ' of ', @min_points_in_window, ' needed)')
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
LEFT JOIN healthy_phones h ON h.employee_id = e.id
LEFT JOIN (
  SELECT employee_id, COUNT(*) AS n, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @density_window_h HOUR)
  GROUP BY employee_id
) pts ON pts.employee_id = e.id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
ORDER BY outcome DESC, points_in_window DESC, e.emp_id;


-- 2. BEFORE -------------------------------------------------------------------
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


-- 3. THE EMPLOYEE-LEVEL SWITCHES ----------------------------------------------
-- Only for staff with a real work site AND a phone that reports continuously.
UPDATE employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
JOIN healthy_phones h ON h.employee_id = e.id
SET e.work_mode = 'on_site',
    e.live_tracking_enabled = TRUE
WHERE @dry_run = 0
  AND e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site');


-- 4. THE FENCE ITSELF ---------------------------------------------------------
-- The flag that is almost always the blocker: a location is assigned but
-- geofencing was never ticked, so nothing is ever enforced — and clock-in is
-- accepted from anywhere, which is the half people forget. It is one switch for
-- both: fenced clock-in and away-from-site clock-out.
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
JOIN healthy_phones h ON h.employee_id = e.id
SET es.geofencing_enabled = TRUE
WHERE @dry_run = 0
  AND e.is_active = TRUE
  AND e.role = 'employee'
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site');


-- 5. DISARM A FENCE ON A PHONE THAT IS NOT REPORTING --------------------------
-- The mirror of section 4, and the one that would have saved this morning. A
-- fence only works on a phone that reports; on one that does not it closes the
-- day at the last confirmed presence, which for a phone that has sent nothing
-- means the moment they clocked in — zero minutes for a full day's work.
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
SET es.geofencing_enabled = FALSE
WHERE @dry_run = 0
  AND @disarm_silent = 1
  AND es.geofencing_enabled = TRUE
  AND e.is_active = TRUE
  AND e.role = 'employee'
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND NOT EXISTS (SELECT 1 FROM healthy_phones h WHERE h.employee_id = e.id);


-- 6. AFTER --------------------------------------------------------------------
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


-- 7. THE PHONES TO FIX --------------------------------------------------------
-- Everyone with a work site whose handset is not reporting well enough to be
-- fenced. Each needs, ON THE PHONE: the current APK, location permission set to
-- "Allow all the time" (NOT "While using the app"), and battery optimisation
-- turned OFF for the app. Compare points_in_window against ~720 — that is what
-- a correctly configured phone produces in 6 hours.
SELECT e.emp_id, e.name,
       COALESCE(l.name, '— no site —')                          AS site,
       COALESCE(pts.n, 0)                                       AS points_in_window,
       CONCAT(@min_points_in_window, ' needed, ~720 is healthy') AS target,
       COALESCE(CONCAT(TIMESTAMPDIFF(MINUTE, pts.last_ping, UTC_TIMESTAMP()), ' min ago'),
                'NEVER')                                        AS last_ping
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
LEFT JOIN (
  SELECT employee_id, COUNT(*) AS n, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @density_window_h HOUR)
  GROUP BY employee_id
) pts ON pts.employee_id = e.id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND es.location_id IS NOT NULL
  AND l.id IS NOT NULL
  AND (@include_field_staff = 1 OR e.work_mode = 'on_site')
  AND NOT EXISTS (SELECT 1 FROM healthy_phones h WHERE h.employee_id = e.id)
ORDER BY points_in_window DESC, e.emp_id;


-- 8. WHO IS STILL NOT COVERED, AND WHY ----------------------------------------
SELECT e.emp_id, e.name,
       CASE
         WHEN es.id IS NULL            THEN 'no schedule at all'
         WHEN es.location_id IS NULL   THEN 'NO WORK LOCATION — assign one'
         WHEN l.is_active <> 1         THEN 'location is deactivated'
         WHEN e.work_mode <> 'on_site' THEN 'off-site staff — left alone on purpose'
         WHEN NOT EXISTS (SELECT 1 FROM healthy_phones h WHERE h.employee_id = e.id)
                                       THEN 'phone not reporting — see the list above'
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
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND NOT (es.location_id IS NOT NULL AND l.is_active = 1
           AND e.work_mode = 'on_site' AND es.geofencing_enabled = 1)
ORDER BY why_not, e.emp_id;


-- 9. FENCES THAT ARE TOO TIGHT ------------------------------------------------
-- A phone's GPS drifts by tens of metres indoors. A fence smaller than that
-- clocks people out while they sit at their desk, and they will blame the app
-- rather than the radius. 50-200 m is a sensible office fence.
SELECT id, name, radius_meters,
       CONCAT('widen to at least ', @tight_fence_m, 'm') AS advice
FROM locations
WHERE is_active = TRUE AND radius_meters < @tight_fence_m
ORDER BY radius_meters;

DROP TEMPORARY TABLE IF EXISTS healthy_phones;


-- Auto clock-out then happens within GEOFENCE_PRESENCE_GRACE_MIN minutes of an
-- employee's presence no longer being confirmed inside their fence. The server
-- sweep runs every LIVE_MONITOR_INTERVAL_MIN minutes.
--
-- BEFORE ARMING ANYONE, make sure auto clock-IN works on their handset. Auto
-- clock-out runs on the server and always works; auto clock-in runs in the app.
-- Arming a phone whose app cannot clock them back in means they are clocked out
-- for walking to lunch and stay that way until they notice.
--
-- To undo everything this did, for one person or for all:
--   UPDATE employee_schedules es JOIN employees e ON e.id = es.employee_id
--      SET es.geofencing_enabled = FALSE
--    WHERE e.emp_id = 'RACE013';   -- or drop the WHERE for everybody
