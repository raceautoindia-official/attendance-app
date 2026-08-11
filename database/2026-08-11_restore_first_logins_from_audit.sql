-- =============================================================================
-- RESTORE THE TRUE FIRST LOGIN OF EVERY DAY, FROM THE AUDIT LOG
--
--   cd ~/attendance-app && mysql --table -u "$(grep -m1 '^DB_USER=' .env | cut -d= -f2-)" -p"$(grep -m1 '^DB_PASSWORD=' .env | cut -d= -f2-)" "$(grep -m1 '^DB_NAME=' .env | cut -d= -f2-)" < database/2026-08-11_restore_first_logins_from_audit.sql
--
-- first_clock_in_utc was added after months of multi-session days had already
-- overwritten their morning login — the migration could only backfill each row
-- with whatever value was still stored, which for any re-opened day is the
-- IN-BETWEEN login, not the morning. Reena's 11-08 row read 10:55 when she had
-- logged in earlier; every historical multi-session day has the same flaw.
--
-- The audit log never overwrote anything: every clock_in action is there with
-- its timestamp and its work_date. This script sets each attendance row's
-- first_clock_in_utc to the EARLIEST audited clock-in of that employee's day,
-- wherever that is earlier than what the row currently claims.
--
-- Run AFTER database/migrations/2026-08-11_add_first_clock_in.sql (it fails
-- loudly, not silently, if the column is missing). Safe to re-run: it only
-- ever moves a value EARLIER, and a second run finds nothing left to move.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- What will change, so the run is reviewable before and provable after.
SELECT e.emp_id, e.name,
       DATE_FORMAT(a.work_date, '%Y-%m-%d')                       AS work_date,
       CONVERT_TZ(a.first_clock_in_utc, '+00:00', '+05:30')       AS shown_login_ist,
       CONVERT_TZ(fx.true_first, '+00:00', '+05:30')              AS audited_first_ist
FROM attendance a
JOIN employees e ON e.id = a.employee_id
JOIN (
  SELECT JSON_EXTRACT(al.details, '$.employee_id')                AS employee_id,
         JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.work_date'))    AS work_date,
         MIN(al.created_at)                                       AS true_first
  FROM audit_log al
  WHERE al.action = 'clock_in'
  GROUP BY employee_id, work_date
) fx ON fx.employee_id = a.employee_id
    AND fx.work_date = DATE_FORMAT(a.work_date, '%Y-%m-%d')
WHERE a.first_clock_in_utc IS NOT NULL
  AND fx.true_first < DATE_SUB(a.first_clock_in_utc, INTERVAL 2 MINUTE)
ORDER BY a.work_date DESC, e.emp_id;

-- The repair itself. The 2-minute guard skips rows where audit and attendance
-- agree within write-lag, so nothing churns on repeated runs.
UPDATE attendance a
JOIN (
  SELECT JSON_EXTRACT(al.details, '$.employee_id')                AS employee_id,
         JSON_UNQUOTE(JSON_EXTRACT(al.details, '$.work_date'))    AS work_date,
         MIN(al.created_at)                                       AS true_first
  FROM audit_log al
  WHERE al.action = 'clock_in'
  GROUP BY employee_id, work_date
) fx ON fx.employee_id = a.employee_id
    AND fx.work_date = DATE_FORMAT(a.work_date, '%Y-%m-%d')
SET a.first_clock_in_utc = fx.true_first
WHERE a.first_clock_in_utc IS NOT NULL
  AND fx.true_first < DATE_SUB(a.first_clock_in_utc, INTERVAL 2 MINUTE);

SELECT ROW_COUNT() AS days_restored;

-- Today's rows, as they now read — the row that prompted this should show the
-- morning. If the audited first differs from what somebody remembers, the
-- audit log is the record: it wrote the time the moment the button was tapped.
SELECT e.emp_id, e.name,
       CONVERT_TZ(a.first_clock_in_utc, '+00:00', '+05:30') AS first_login_ist,
       CONVERT_TZ(a.clock_in_utc, '+00:00', '+05:30')       AS current_session_ist,
       a.session_count
FROM attendance a
JOIN employees e ON e.id = a.employee_id
WHERE a.work_date = (SELECT DATE(DATE_SUB(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), INTERVAL 7 HOUR)))
  AND a.first_clock_in_utc IS NOT NULL
ORDER BY e.emp_id;
