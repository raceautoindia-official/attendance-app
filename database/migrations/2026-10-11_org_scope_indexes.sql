-- ---------------------------------------------------------------------------
-- 2026-10-11_org_scope_indexes.sql
--
-- Composite indexes for the permission hot path.
--
-- Resolving a `department` or `team` scope runs on EVERY request a scoped user
-- makes, and it asks the same shape of question each time:
--
--   WHERE department_id IN (...)
--     AND effective_from <= ?
--     AND (effective_to IS NULL OR effective_to >= ?)
--
-- The existing indexes cover only the leading column, so the date range was
-- filtered row by row after the index lookup. That is invisible at seventeen
-- employees and is the first thing to hurt at two thousand - and it hurts on
-- every page at once, because it is the access check rather than any one
-- feature.
--
-- Index-only additions: no table is rewritten, no column changes, nothing is
-- renamed. Safe to apply while the application is running.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

-- Department scope: the subtree lookup.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_org_assignments'
    AND INDEX_NAME = 'idx_org_dept_dates');
SET @sql := IF(@have = 0,
  'ALTER TABLE employee_org_assignments
     ADD INDEX idx_org_dept_dates (department_id, effective_from, effective_to)',
  'SELECT ''idx_org_dept_dates already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Team scope: same shape, different column.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_org_assignments'
    AND INDEX_NAME = 'idx_org_team_dates');
SET @sql := IF(@have = 0,
  'ALTER TABLE employee_org_assignments
     ADD INDEX idx_org_team_dates (team_id, effective_from, effective_to)',
  'SELECT ''idx_org_team_dates already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- resolveAccess reads this for every request made by anybody holding a role,
-- joining through to roles and permissions. The unique key starts with
-- employee_id so it already serves the lookup; this covers the join back the
-- other way, which listRoleHolders does for the whole company.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_permissions'
    AND INDEX_NAME = 'idx_rp_role_scope');
SET @sql := IF(@have = 0,
  'ALTER TABLE role_permissions ADD INDEX idx_rp_role_scope (role_id, scope)',
  'SELECT ''idx_rp_role_scope already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- The holiday calendar is read per year and country by every hours
-- calculation that touches a month.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
    AND INDEX_NAME = 'idx_holiday_country_year');
SET @sql := IF(@have = 0,
  'ALTER TABLE holiday_calendar ADD INDEX idx_holiday_country_year (country_code, year)',
  'SELECT ''idx_holiday_country_year already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
