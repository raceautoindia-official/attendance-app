-- =============================================================================
-- attendance.first_clock_in_utc — the day's FIRST login, kept forever
--
--   mysql -u <user> -p <database> < database/migrations/2026-08-11_add_first_clock_in.sql
--
-- A multi-session day reuses one attendance row, and every re-login OVERWROTE
-- clock_in_utc with the new session's start. So an employee who logged in at
-- 9:09, was auto clocked out at lunch and returned at 12:20 showed "12:20"
-- as their login everywhere — and the 9:09 existed nowhere but the audit log.
-- The complaint was word for word: "you have to record everything, but you
-- show the in-between login time".
--
-- first_clock_in_utc is written on the day's first clock-in and never touched
-- again. clock_in_utc keeps meaning "current session start", which the session
-- maths (clock-out minutes, the watchdog's since-clock-in window, the 07:00
-- settle) all depend on. Displays show the first; the current session start
-- remains visible alongside where it differs.
--
-- Backfill: existing rows get their current clock_in_utc — the earliest value
-- still stored. Days that already lost their morning to an overwrite cannot be
-- repaired from here (the audit log still has them, case by case).
--
-- Safe to re-run.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
    AND COLUMN_NAME = 'first_clock_in_utc');

SET @sql := IF(@exists = 0,
  'ALTER TABLE attendance
     ADD COLUMN first_clock_in_utc DATETIME NULL
       COMMENT ''The day''''s first login. Never overwritten by later sessions.''
       AFTER work_date',
  'SELECT ''first_clock_in_utc already present - nothing to do'' AS note');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE attendance
   SET first_clock_in_utc = clock_in_utc
 WHERE first_clock_in_utc IS NULL
   AND clock_in_utc IS NOT NULL;

SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
  AND COLUMN_NAME IN ('first_clock_in_utc', 'clock_in_utc');
