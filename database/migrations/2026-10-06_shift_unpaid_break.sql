-- =============================================================================
-- 2026-10-06 - Unpaid break allowance per shift
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-06_shift_unpaid_break.sql
--
-- WHY
-- ---
-- A shift's requirement is derived from its clock span: 09:00-18:00 means nine
-- hours. That span INCLUDES the lunch break. But `attendance.total_minutes`
-- EXCLUDES any time the employee was clocked out - so somebody who clocks out
-- for lunch is measured net and judged against a gross target, while a
-- colleague who stays clocked in through lunch is measured gross against the
-- same target.
--
-- Measured on production for September 2026: Reena Evanjaline clocked out for
-- lunch on 10 days and averages 8.55 h/day (205.4 h for the month). KADALI
-- SRIDATTA GANESH BABU never clocked out and averages 10.98 h (318.4 h). Both
-- are judged against 225 h. Roughly 20 of Reena's 20-hour shortfall is lunch
-- she recorded correctly. The app was quietly penalising the better record.
--
-- `unpaid_break_minutes` makes the deduction explicit, so two employees'
-- monthly totals mean the same thing.
--
--   net requirement per day = shift span (or required_hours) - unpaid_break_minutes
--
-- NULL BY DESIGN
-- -------------
-- The column is nullable with no default, and NULL means "deduct nothing" -
-- byte-for-byte the behaviour before this migration. Existing reports do not
-- move until an administrator sets a value on a shift, which makes the policy
-- an explicit, auditable decision rather than a silent change to everyone's
-- numbers.
--
-- Additive only: a new nullable column on `shifts`. The mobile app shares this
-- database and reads no column it did not already read.
--
-- Idempotent - safe to re-run; the second run reports "already present".
-- =============================================================================

SET @col_exists := (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'shifts'
     AND COLUMN_NAME = 'unpaid_break_minutes'
);

SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE shifts
     ADD COLUMN unpaid_break_minutes SMALLINT UNSIGNED NULL
       COMMENT "Minutes of unpaid break inside the shift span. NULL = deduct nothing."
       AFTER required_hours',
  'SELECT ''shifts.unpaid_break_minutes already present'' AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verification: the column exists and nothing has been given a value yet, so
-- every existing report still produces the figures it produced before.
SELECT
  'shifts.unpaid_break_minutes' AS what,
  COUNT(*)                      AS column_present,
  'must be 1'                   AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'shifts'
  AND COLUMN_NAME = 'unpaid_break_minutes';

SELECT
  'shifts with a break policy set' AS what,
  COUNT(*)                         AS shifts,
  '0 right after this migration — set per shift when the policy is agreed' AS detail
FROM shifts
WHERE unpaid_break_minutes IS NOT NULL;
