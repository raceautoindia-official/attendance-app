-- =============================================================================
-- 2026-10-03 - Clear auth_method on system-generated attendance rows
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-03_fix_auth_method_on_generated_rows.sql
--
-- PREREQUISITE: 2026-06-03_attendance_auth_method_nullable.sql must be applied
-- first, or this fails because the column is still NOT NULL. Check with:
--   mysql -u <user> -p <database> < database/migrations/check-status.sql
--
-- WHY
-- ---
-- `markAbsentees` and `markSundayHolidays` insert only (employee_id, work_date,
-- status). While `attendance.auth_method` was NOT NULL with no DEFAULT, MySQL
-- filled it with the FIRST enum value - 'webauthn' - so every absent day, every
-- Sunday week-off and every holiday row claimed a passkey authentication that
-- never took place.
--
-- That matters beyond tidiness: `auth_method` is shown in the admin attendance
-- table and exported in the CSV and PDF reports, so the records assert an
-- authentication event for days nobody even logged in. The audit trail was
-- quietly wrong.
--
-- The root cause was that 2026-06-03 never ran on this database: it carried a
-- hardcoded `USE attendance_db;`, and the database is named something else.
-- That USE has been removed from every migration.
--
-- SCOPE
-- -----
-- Only rows with NO clock-in and a non-working status. A row with a clock-in was
-- created by a real authentication and is left exactly as it is.
--
-- Idempotent - safe to re-run; the second run matches nothing.
-- =============================================================================

UPDATE attendance
   SET auth_method = NULL
 WHERE clock_in_utc IS NULL
   AND auth_method IS NOT NULL
   AND status IN ('absent', 'holiday', 'leave');

-- Verification: both counts should be 0 afterwards.
SELECT
  'rows still mislabelled' AS check_name,
  COUNT(*) AS should_be_zero
FROM attendance
WHERE clock_in_utc IS NULL
  AND auth_method IS NOT NULL
  AND status IN ('absent', 'holiday', 'leave');

SELECT
  'rows WITH a clock-in that lost auth_method' AS check_name,
  COUNT(*) AS should_be_zero
FROM attendance
WHERE clock_in_utc IS NOT NULL
  AND auth_method IS NULL;
