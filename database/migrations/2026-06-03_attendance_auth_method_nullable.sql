-- =============================================================================
-- 2026-06-03  Make attendance.auth_method nullable
-- -----------------------------------------------------------------------------
-- Rows created without a login event (e.g. the nightly mark-absent job, which
-- inserts `absent` rows) have no authentication method. The column was NOT NULL
-- with no default, so those inserts failed under MySQL strict mode. Allow NULL.
-- =============================================================================

-- (no USE statement: the target database is selected by the caller,
--  e.g. `mysql -u <user> -p <database> < this-file.sql`. A hardcoded
--  USE breaks any deployment whose database is named differently.)

ALTER TABLE attendance
  MODIFY auth_method ENUM('webauthn','pin_exemption') NULL;
