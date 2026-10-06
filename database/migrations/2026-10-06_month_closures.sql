-- =============================================================================
-- 2026-10-06 - Month close and lock
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-06_month_closures.sql
--
-- WHY
-- ---
-- Until a month can be closed, a report run today and the same report run next
-- week can differ, and neither is authoritative. Somebody edits an attendance
-- row, a late clock-out settles, an absence is corrected - all legitimate, all
-- silent, and all after the figures were used. That is fine for an operational
-- view and unacceptable for one that decides pay.
--
-- Closing a month records that somebody reviewed it, who, and when. From then
-- on the attendance for that month is read-only: corrections need the month
-- reopened, which is itself recorded. Nothing is deleted and nothing is frozen
-- into a snapshot table - the lock is a gate on writes, so the figures stay
-- live and derived rather than duplicated into a second source of truth that
-- could drift from the first.
--
-- SCOPE OF THE LOCK
-- -----------------
-- A closed month blocks EDITS to attendance and leave for dates inside it. It
-- does not block clock-in or clock-out, because you cannot clock into a past
-- month anyway, and the mobile app must never find itself refused for a reason
-- it has no way to explain. The guard lives in the admin edit paths.
--
-- `closed_through` is a DATE rather than a year/month pair so a part-month can
-- be closed - payroll run on the 25th, say - without inventing a second shape
-- for it later.
--
-- Additive only: one new table. The mobile app shares this database and reads
-- nothing here.
--
-- Idempotent - safe to re-run; the second run reports "already present".
-- =============================================================================

CREATE TABLE IF NOT EXISTS month_closures (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  -- The period being closed. `period_month` is the first day of the month, so
  -- it sorts and compares as a date without any string handling.
  period_month   DATE NOT NULL COMMENT 'First day of the closed month',
  -- Everything up to and including this date is locked. Normally the last day
  -- of the month; earlier for a part-month close.
  closed_through DATE NOT NULL,
  is_closed      TINYINT(1) NOT NULL DEFAULT 1,
  closed_by      INT NULL,
  closed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Reopening is not an undo: the original close is kept and these record that
  -- it was lifted, by whom, and why. An auditor needs to see that it happened.
  reopened_by    INT NULL,
  reopened_at    DATETIME NULL,
  reopen_reason  VARCHAR(500) NULL,
  notes          VARCHAR(500) NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_month_closure (period_month),
  KEY idx_closed_through (closed_through),
  CONSTRAINT fk_month_closure_closed_by
    FOREIGN KEY (closed_by) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_month_closure_reopened_by
    FOREIGN KEY (reopened_by) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verification.
SELECT
  'month_closures' AS what,
  COUNT(*)         AS table_present,
  'must be 1'      AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'month_closures';

SELECT
  'closed months' AS what,
  COUNT(*)        AS rows_present,
  '0 right after this migration — nothing is locked until somebody closes it' AS detail
FROM month_closures WHERE is_closed = 1;
