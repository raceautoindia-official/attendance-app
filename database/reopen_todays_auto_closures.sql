-- =============================================================================
-- Give back a day the system closed too early.
--
--   mysql -u <user> -p <database> < database/reopen_todays_auto_closures.sql
--
-- For the rows reading "09:20 in, 09:20 out, 0h 0m, present": the geofence
-- watchdog credited each day up to the last moment a fix placed the employee
-- inside their fence, and when the phone never reported, that moment is the
-- clock-in itself. The day closed at the second it opened — and because the row
-- now had a clock-out it read as COMPLETE, so they could not clock in again.
--
-- The day is NOT over, so there is nothing to settle: guessing what somebody
-- worked at ten in the morning would be inventing a number. Clearing the
-- clock-out puts them back where they were — still clocked in, hours counting
-- from their real arrival — and tonight's sweep settles the day properly.
--
-- Edit the two variables below, then run the whole file. Steps 1 and 5 only
-- look; steps 2-4 change things and are meant to be run together.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---- WHAT TO CORRECT --------------------------------------------------------
SET @work_date := '2026-08-18';
SET @employees := 'RACE001,RACE008,RACE020';   -- comma separated, no spaces
-- -----------------------------------------------------------------------------

-- FIND_IN_SET wants a plain list; this is how one variable stands in for an IN
-- clause without building the SQL by hand.
SET @emp_list := REPLACE(@employees, ' ', '');


-- -----------------------------------------------------------------------------
-- 1. LOOK FIRST — what is about to change, and why it was closed.
-- -----------------------------------------------------------------------------
SELECT e.emp_id,
       e.name,
       DATE_FORMAT(a.work_date, '%Y-%m-%d')                 AS work_date,
       CONVERT_TZ(a.clock_in_utc,  '+00:00', '+05:30')      AS clock_in_ist,
       CONVERT_TZ(a.clock_out_utc, '+00:00', '+05:30')      AS closed_at_ist,
       a.total_minutes                                      AS credited_minutes,
       a.status,
       MAX(al.action)                                       AS closed_by,
       MAX(JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.reason'))) AS why
FROM attendance a
JOIN employees e ON e.id = a.employee_id
LEFT JOIN audit_log al ON al.entity = 'attendance' AND al.entity_id = a.id
     AND al.action IN ('geofence_auto_clockout', 'session_auto_closed')
WHERE a.work_date = @work_date
  AND FIND_IN_SET(e.emp_id, @emp_list)
  AND a.clock_out_utc IS NOT NULL
GROUP BY a.id, e.emp_id, e.name, a.work_date, a.clock_in_utc, a.clock_out_utc,
         a.total_minutes, a.status;


-- -----------------------------------------------------------------------------
-- 2. STOP IT HAPPENING AGAIN IN THIRTY MINUTES.
--
--    The watchdog closed these once and will close them again within
--    GEOFENCE_PRESENCE_GRACE_MIN (default 30) unless geofencing is off. Without
--    this the repair quietly undoes itself and nothing looks fixed.
--
--    This disarms the fences for EVERYONE — it is the blunt version, and the
--    right one while the phones are not reporting at all. Re-arm from
--    database/enable_auto_logout.sql once they are.
--
--    COMMENTED OUT because it affects the whole company, not just these three.
--    Uncomment it unless you have already disarmed.
-- -----------------------------------------------------------------------------
-- UPDATE employee_schedules SET geofencing_enabled = FALSE
--  WHERE geofencing_enabled = TRUE;


-- -----------------------------------------------------------------------------
-- 3. RECORD THE CORRECTION — before making it, so the old figures survive.
--
--    A correction that leaves no trace is just a different kind of wrong
--    number. This captures the clock-out being removed and the credit being
--    withdrawn, so the change can be explained or undone later.
-- -----------------------------------------------------------------------------
INSERT INTO audit_log (action, entity, entity_id, performed_by, details, created_at)
SELECT 'attendance_reopened',
       'attendance',
       a.id,
       NULL,
       JSON_OBJECT(
         'emp_id',                 e.emp_id,
         'employee_id',            a.employee_id,
         'work_date',              DATE_FORMAT(a.work_date, '%Y-%m-%d'),
         'reason',                 'premature_system_clock_out',
         'previous_clock_out_utc', a.clock_out_utc,
         'previous_total_minutes', a.total_minutes,
         'repaired_by',            'database/reopen_todays_auto_closures.sql'),
       UTC_TIMESTAMP()
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.work_date = @work_date
  AND FIND_IN_SET(e.emp_id, @emp_list)
  AND a.clock_out_utc IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 4. REOPEN THE DAY.
--
--    banked_minutes and session_count are deliberately untouched: an employee
--    who completed an earlier session today has those minutes banked, and
--    clearing them would throw away real work.
-- -----------------------------------------------------------------------------
UPDATE attendance a
  JOIN employees e ON e.id = a.employee_id
   SET a.clock_out_utc = NULL,
       a.clock_out_lat = NULL,
       a.clock_out_lng = NULL,
       a.total_minutes = NULL
 WHERE a.work_date = @work_date
   AND FIND_IN_SET(e.emp_id, @emp_list)
   AND a.clock_out_utc IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 5. CHECK — clock_out and total should now both be NULL, status unchanged.
--    Each person is clocked in again and can use the app normally.
-- -----------------------------------------------------------------------------
SELECT e.emp_id,
       e.name,
       CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30') AS clock_in_ist,
       a.clock_out_utc,
       a.total_minutes,
       a.status
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.work_date = @work_date
  AND FIND_IN_SET(e.emp_id, @emp_list);
