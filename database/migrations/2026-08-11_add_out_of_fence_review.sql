-- =============================================================================
-- attendance.out_of_fence_status / reviewed_by / reviewed_at / review_notes
--
--   mysql -u <user> -p <database> < database/migrations/2026-08-11_add_out_of_fence_review.sql
--
-- An off-site clock-in is now a REVIEWABLE event: it turns up in the admin's
-- Notifications tab to be approved or rejected.
--
-- IT IS NOT AN APPROVAL GATE. The employee is clocked in the moment they give a
-- reason, and stays clocked in whether or not anybody ever looks at it. An
-- unreviewed clock-in counts exactly as much as an approved one — their hours,
-- their status, their pay. Nobody's day should hang on how quickly a manager
-- reads a list.
--
-- What the review records is the ADMIN's position on it:
--
--   pending  — nobody has looked yet. Counts as attendance.
--   approved — the admin agrees the trip was legitimate.
--   rejected — the admin disputes it. STILL counts as attendance; the day is
--              flagged for a conversation, not silently unpaid. Deleting hours
--              somebody worked is an explicit edit, not a side effect of a
--              button on a notifications screen.
--
-- NULL status means this clock-in was never off-site at all.
--
-- Safe to re-run: each column is checked for individually.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @has_status := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
    AND COLUMN_NAME = 'out_of_fence_status');

SET @sql := IF(@has_status = 0,
  "ALTER TABLE attendance
     ADD COLUMN out_of_fence_status ENUM('pending','approved','rejected') NULL
       COMMENT 'Admin review of an off-site clock-in. Never gates attendance.'
       AFTER out_of_fence_reason,
     ADD COLUMN out_of_fence_reviewed_by INT NULL AFTER out_of_fence_status,
     ADD COLUMN out_of_fence_reviewed_at DATETIME NULL AFTER out_of_fence_reviewed_by,
     ADD COLUMN out_of_fence_review_notes VARCHAR(500) NULL AFTER out_of_fence_reviewed_at",
  "SELECT 'review columns already present - nothing to do' AS note");

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- The Notifications tab asks one question constantly: what is still pending?
SET @has_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
    AND INDEX_NAME = 'idx_attendance_out_of_fence_status');

SET @sql2 := IF(@has_idx = 0,
  'ALTER TABLE attendance
     ADD INDEX idx_attendance_out_of_fence_status (out_of_fence_status, clock_in_utc)',
  "SELECT 'idx_attendance_out_of_fence_status already present' AS note");

PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;


-- Anything already recorded as off-site, before this migration, has never been
-- reviewed — so it is pending, not silently approved.
UPDATE attendance
   SET out_of_fence_status = 'pending'
 WHERE out_of_fence_reason IS NOT NULL
   AND out_of_fence_status IS NULL;


SELECT COLUMN_NAME, COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
  AND COLUMN_NAME LIKE 'out_of_fence%'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS off_site_clock_ins_awaiting_review
FROM attendance WHERE out_of_fence_status = 'pending';
