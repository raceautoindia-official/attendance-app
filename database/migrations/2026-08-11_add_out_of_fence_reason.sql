-- =============================================================================
-- attendance.out_of_fence_reason
--
--   mysql -u <user> -p <database> < database/migrations/2026-08-11_add_out_of_fence_reason.sql
--
-- Clocking in from outside the work site was simply refused, which is right for
-- someone trying it on and wrong for the ordinary case: a delivery, a customer
-- visit, a site inspection. The employee could do nothing but give up, and no
-- record was kept that they had tried.
--
-- They can now clock in from outside by giving a reason. The attendance row
-- keeps geofence_status = 'outside' — the fact is not softened — and the reason
-- is stored here, in its own column rather than in `notes`, which belongs to
-- admin edits and would otherwise be silently overwritten by one.
--
-- An admin is emailed and the whole thing is written to the audit log, so this
-- is a recorded exception rather than a hole in the fence.
--
-- Safe to re-run: it checks for itself first.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'attendance'
    AND COLUMN_NAME  = 'out_of_fence_reason'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE attendance
     ADD COLUMN out_of_fence_reason VARCHAR(500) NULL
       COMMENT ''Why this clock-in was allowed from outside the work site''
       AFTER geofence_status',
  'SELECT ''out_of_fence_reason already present - nothing to do'' AS note');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'attendance'
  AND COLUMN_NAME IN ('geofence_status', 'out_of_fence_reason')
ORDER BY ORDINAL_POSITION;
