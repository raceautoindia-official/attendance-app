-- =============================================================================
-- 2026-10-06 - Regularisation requests
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-06_regularisation_requests.sql
--
-- WHY
-- ---
-- An employee who forgets to clock out loses hours, and the only way to get
-- them back today is for an administrator to edit the attendance row directly.
-- That edit is recorded (`attendance.edited_by`, `edited_at`) but the REQUEST
-- is not: there is no record of who asked, what they said happened, who agreed,
-- or why. The correction and the reason for it live in different places, and
-- one of them is somebody's memory.
--
-- A regularisation request puts the whole exchange on the record. The employee
-- states what they say the times should be and why; a manager or administrator
-- approves or rejects with a note; approval applies the change and writes the
-- audit entry. Nothing about the existing edit path is removed - this is the
-- trail around it.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not let an employee change their own attendance. A request is a
-- request: the row is only touched when somebody with the authority to edit it
-- approves. And a request against a closed month is refused for the same reason
-- a direct edit is.
--
-- Additive only: one new table. The mobile app shares this database and reads
-- nothing here.
--
-- Idempotent - safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS regularisation_requests (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  employee_id           INT NOT NULL,
  work_date             DATE NOT NULL,
  -- What the employee says the times should be. NULL means "leave this one as
  -- it is" - a forgotten clock-out only needs the clock-out corrected.
  requested_clock_in    DATETIME NULL,
  requested_clock_out   DATETIME NULL,
  reason                VARCHAR(500) NOT NULL,
  status                ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  -- Who raised it: the employee themselves, or an admin on their behalf.
  requested_by          INT NULL,
  reviewed_by           INT NULL,
  reviewed_at           DATETIME NULL,
  review_notes          VARCHAR(500) NULL,
  -- What the row held BEFORE approval, so the change is reversible and
  -- auditable without reading the audit log back.
  previous_clock_in     DATETIME NULL,
  previous_clock_out    DATETIME NULL,
  previous_total_minutes INT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_reg_employee_date (employee_id, work_date),
  KEY idx_reg_status (status, created_at),
  CONSTRAINT fk_reg_employee  FOREIGN KEY (employee_id)  REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_reg_requester FOREIGN KEY (requested_by) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_reg_reviewer  FOREIGN KEY (reviewed_by)  REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verification.
SELECT
  'regularisation_requests' AS what,
  COUNT(*)                  AS table_present,
  'must be 1'               AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'regularisation_requests';

SELECT
  'pending requests' AS what,
  COUNT(*)           AS rows_present,
  '0 right after this migration' AS detail
FROM regularisation_requests WHERE status = 'pending';
