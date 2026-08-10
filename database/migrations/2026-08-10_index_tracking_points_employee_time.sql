-- =============================================================================
-- live_tracking_points: index (employee_id, tracked_at_utc) together
--
--   mysql -u <user> -p <database> < database/migrations/2026-08-10_index_tracking_points_employee_time.sql
--
-- Every question this table is ever asked is "the most recent point(s) for ONE
-- employee since a given moment" — the away-from-site watchdog asks it for each
-- clocked-in employee on every sweep, and the diagnostics ask it again.
--
-- employee_id and tracked_at_utc were indexed separately, so MySQL could use
-- one or the other but never both: it would fetch every point that employee has
-- ever recorded and sort them by hand to find the newest. A phone reporting
-- every 15 seconds writes about 5,760 rows a day, so after a few weeks that is
-- a filesort over hundreds of thousands of rows, repeated per employee, every
-- LIVE_MONITOR_INTERVAL_MIN minutes. On a small database it is invisible; on a
-- real one the diagnostic query had to be killed by hand.
--
-- Together as one index, the same lookup becomes a range scan over just that
-- employee's points since clock-in, read newest-first, stopping at the first
-- match. No sort at all.
--
-- Safe to re-run: it checks for itself first and does nothing if present.
-- Adding an index locks the table briefly — on a large table give it a quiet
-- moment, though on InnoDB writes are not blocked.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'live_tracking_points'
    AND INDEX_NAME   = 'idx_ltp_employee_tracked_at'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE live_tracking_points
     ADD INDEX idx_ltp_employee_tracked_at (employee_id, tracked_at_utc)',
  'SELECT ''idx_ltp_employee_tracked_at already present - nothing to do'' AS note');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- The audit log is read the same way by the diagnostics: one action, newest
-- first. Only performed_by, created_at and (entity, entity_id) were indexed, so
-- filtering by action meant walking the whole table.
SET @exists2 := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'audit_log'
    AND INDEX_NAME   = 'idx_audit_log_action_created_at'
);

SET @sql2 := IF(@exists2 = 0,
  'ALTER TABLE audit_log
     ADD INDEX idx_audit_log_action_created_at (action, created_at)',
  'SELECT ''idx_audit_log_action_created_at already present - nothing to do'' AS note');

PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;


SELECT 'indexes now on live_tracking_points' AS report, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_points'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;
