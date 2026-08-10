-- =============================================================================
-- TODAY'S ATTENDANCE — everyone, live
--
--   mysql -u <user> -p <database> < database/attendance_today.sql
--
-- "Today" is the WORK day, which starts at 07:00 IST — not midnight. Between
-- midnight and 07:00 this still reports the day that began yesterday morning,
-- which is the whole point: a night shift is one day, not two halves.
--
-- Nothing here is a report of the past. It shows who is on site right now, who
-- has not turned up, and how long each person has been working.
-- =============================================================================

-- The current work date, by the same rule the app uses.
SET @work_date := DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), INTERVAL 7 HOUR));

-- Narrow to one person (partial match on name or emp_id), or leave it EMPTY
-- to report on everybody.
SET @who := 'reena';   -- <<< e.g. 'reena', 'RACE018', or '' for all

SELECT CONCAT('Work day ', DATE_FORMAT(@work_date, '%d-%m-%Y (%a)'),
              ' — 07:00 that morning to 07:00 the next. IST now ',
              DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30'), '%H:%i')) AS reporting_on;


-- 1. EVERY ACTIVE EMPLOYEE ----------------------------------------------------
-- Employees with no row yet appear too, as 'not clocked in' — that is usually
-- the thing you actually want to see.
SELECT
  e.emp_id,
  e.name,
  COALESCE(a.status, 'not clocked in')                                AS status,
  DATE_FORMAT(CONVERT_TZ(a.clock_in_utc,  '+00:00','+05:30'), '%H:%i') AS in_ist,
  DATE_FORMAT(CONVERT_TZ(a.clock_out_utc, '+00:00','+05:30'), '%H:%i') AS out_ist,
  CASE
    WHEN a.clock_in_utc IS NULL                       THEN '-'
    WHEN a.clock_out_utc IS NOT NULL                  THEN 'finished'
    ELSE 'STILL WORKING'
  END                                                                 AS now,
  -- Hours so far: a finished day is its stored total; an open one is the
  -- minutes banked from earlier sessions plus however long the current one has
  -- been running. This is what the employee sees ticking on their phone.
  CONCAT(
    FLOOR(CAST(COALESCE(a.total_minutes,
      a.banked_minutes + GREATEST(0, TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP()))
    , 0) AS SIGNED)/60), 'h ',
    LPAD(MOD(CAST(COALESCE(a.total_minutes,
      a.banked_minutes + GREATEST(0, TIMESTAMPDIFF(MINUTE, a.clock_in_utc, UTC_TIMESTAMP()))
    , 0) AS SIGNED),60),2,'0'), 'm')                                  AS hours_so_far,
  IF(a.clock_in_utc IS NULL, NULL, a.session_count)                   AS sessions,
  a.geofence_status,
  COALESCE(l.name, '-')                                               AS work_location,
  -- Minutes since this phone last reported. Blank means it has never reported.
  -- A large number while STILL WORKING is a phone that has stopped tracking.
  (SELECT TIMESTAMPDIFF(MINUTE, MAX(ltp.tracked_at_utc), UTC_TIMESTAMP())
     FROM live_tracking_points ltp
     JOIN live_tracking_sessions lts ON lts.id = ltp.session_id
    WHERE lts.employee_id = e.id)                                     AS phone_silent_min
FROM employees e
LEFT JOIN attendance a
  ON a.employee_id = e.id AND a.work_date = @work_date
LEFT JOIN employee_schedules es
  ON es.id = (
    SELECT id FROM employee_schedules
     WHERE employee_id = e.id
       AND effective_from <= @work_date
       AND (effective_to IS NULL OR effective_to >= @work_date)
     ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
ORDER BY
  CASE COALESCE(a.status, 'not clocked in')
    WHEN 'not clocked in' THEN 1 ELSE 2 END,
  a.clock_in_utc,
  e.emp_id;


-- 2. HEADCOUNT ----------------------------------------------------------------
SELECT
  COUNT(*)                                                     AS active_employees,
  SUM(a.clock_in_utc IS NOT NULL)                              AS clocked_in_today,
  SUM(a.clock_in_utc IS NOT NULL AND a.clock_out_utc IS NULL)  AS on_site_now,
  SUM(a.clock_out_utc IS NOT NULL)                             AS finished,
  SUM(a.id IS NULL)                                            AS no_record_yet,
  SUM(a.status = 'absent')                                     AS marked_absent,
  SUM(a.status IN ('leave','holiday'))                         AS leave_or_holiday
FROM employees e
LEFT JOIN attendance a
  ON a.employee_id = e.id AND a.work_date = @work_date
WHERE e.is_active = TRUE AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'));


-- 3. ANYTHING AUTOMATIC THAT HAPPENED TODAY -----------------------------------
-- Auto clock-outs, away-from-site, refused locations or devices. Empty is
-- normal on a quiet day.
SELECT DATE_FORMAT(CONVERT_TZ(al.created_at,'+00:00','+05:30'), '%H:%i') AS at_ist,
       e.emp_id,
       e.name,
       al.action,
       JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.reason'))                AS reason
FROM audit_log al
JOIN employees e
  ON e.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.employee_id')) AS UNSIGNED)
WHERE al.action IN ('geofence_auto_clockout','session_auto_closed','marked_absent',
                    'location_rejected','device_rejected','session_continued_across_day')
  AND al.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
ORDER BY al.created_at DESC
LIMIT 40;
