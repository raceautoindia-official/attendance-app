-- =============================================================================
-- Who is stuck on "Already clocked in"?
--
--   mysql -u <user> -p <database> < database/stuck_open_sessions.sql
--
-- The symptom is a Today card reading "-" for clock in, clock out and hours,
-- with ALREADY CLOCKED IN in red across it. Both halves are honest: the
-- duplicate guard looks for an open session on ANY day, the card shows only
-- today, and a session left open on an earlier day sits in the gap between
-- them. There is nothing on the employee's screen to clock out of.
--
-- Section 1 finds them. Section 2 is the fix, and is commented out — read what
-- it credits before running it.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The work day ends at 07:00 IST, so "today" is not today's date before 07:00.
SET @today := DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') - INTERVAL 7 HOUR);
SELECT @today AS current_work_date;


-- -----------------------------------------------------------------------------
-- 1. Every session still open from a day that has already ended.
--
--    Anyone listed here cannot clock in. Their app says "Already clocked in"
--    and shows them nothing.
-- -----------------------------------------------------------------------------
SELECT e.emp_id,
       e.name,
       DATE_FORMAT(a.work_date, '%Y-%m-%d')                       AS stuck_since,
       DATEDIFF(@today, a.work_date)                              AS days_stuck,
       CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30')             AS clocked_in_ist,
       a.status,
       a.id                                                       AS attendance_id
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.clock_in_utc IS NOT NULL
  AND a.clock_out_utc IS NULL
  AND a.work_date < @today
ORDER BY a.work_date ASC, e.name ASC;


-- -----------------------------------------------------------------------------
-- 2. Is the end-of-day scheduler settling them?
--
--    It runs in-process every 15 minutes and writes 'session_auto_closed' for
--    each row it settles. A recent entry means the sweep is alive and section 1
--    is a genuine backlog; NOTHING recent, with rows listed above, means the
--    sweep is not running — check pm2 logs for a line reading
--    "[end-of-day] scheduler started".
-- -----------------------------------------------------------------------------
SELECT COUNT(*)       AS auto_closures_last_7_days,
       MAX(created_at) AS most_recent_utc
FROM audit_log
WHERE action = 'session_auto_closed'
  AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY);


-- -----------------------------------------------------------------------------
-- 3. THE FIX — settle each stuck day at the hours actually worked, capped at
--    the moment that work day ended (07:00 IST the following morning).
--
--    This is precisely what the nightly sweep does, applied by hand. Nobody is
--    credited into a day they were not there for, and nobody's real hours are
--    thrown away.
--
--    Uncomment to run. Check section 1 again afterwards — it should be empty.
-- -----------------------------------------------------------------------------
-- UPDATE attendance a
--    SET a.clock_out_utc = GREATEST(
--          a.clock_in_utc,
--          -- 07:00 IST on the day after this work_date, expressed in UTC.
--          CONVERT_TZ(a.work_date + INTERVAL 1 DAY + INTERVAL 7 HOUR, '+05:30', '+00:00')),
--        a.total_minutes = GREATEST(0, TIMESTAMPDIFF(
--          MINUTE,
--          a.clock_in_utc,
--          GREATEST(a.clock_in_utc,
--            CONVERT_TZ(a.work_date + INTERVAL 1 DAY + INTERVAL 7 HOUR, '+05:30', '+00:00'))))
--  WHERE a.clock_in_utc IS NOT NULL
--    AND a.clock_out_utc IS NULL
--    AND a.work_date < @today;
