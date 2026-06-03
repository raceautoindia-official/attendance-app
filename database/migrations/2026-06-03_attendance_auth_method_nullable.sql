-- =============================================================================
-- 2026-06-03  Make attendance.auth_method nullable
-- -----------------------------------------------------------------------------
-- Rows created without a login event (e.g. the nightly mark-absent job, which
-- inserts `absent` rows) have no authentication method. The column was NOT NULL
-- with no default, so those inserts failed under MySQL strict mode. Allow NULL.
-- =============================================================================

USE attendance_db;

ALTER TABLE attendance
  MODIFY auth_method ENUM('webauthn','pin_exemption') NULL;
