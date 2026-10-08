-- =============================================================================
-- 2026-10-07 - Policies (schemes) and their assignment to employees
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-07_policies.sql
--
-- WHY
-- ---
-- Every rule in this app is currently either global (STANDARD_MONTHLY_HOURS, the
-- overtime line) or attached to a shift (required hours, grace, working days).
-- There is no way to say "these people are on 225 hours a year-round contract
-- with PF and ESI, and those people are not".
--
-- A policy is that missing layer: a named bundle of rules an administrator
-- creates once and assigns to many employees.
--
-- THE RULE THAT MAKES THIS SAFE
-- -----------------------------
-- Every rule column is NULLABLE, and an employee with no policy assigned
-- resolves to NULL - at which point every caller falls back to exactly the
-- behaviour the app has today. Nothing moves for anybody until somebody
-- deliberately assigns a policy. Same shape as shifts.unpaid_break_minutes,
-- which has existed for a day and changed no figure anywhere.
--
-- A policy REFERENCES a shift rather than copying its fields. Two places
-- defining "what hours does this shift run" is how they start disagreeing.
--
-- Assignment carries history (effective_from / effective_to), deliberately
-- shaped like employee_schedules. Without it, moving somebody between policies
-- would silently rewrite every month they have already been paid for.
--
-- Additive only: two new tables, and four new values on an existing enum. The
-- mobile app shares this database and reads nothing here.
--
-- Idempotent - safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS policies (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  -- Short handle an administrator can refer to, e.g. STAFF-225.
  code          VARCHAR(40)  NOT NULL,
  description   VARCHAR(500) NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,

  -- ---- Hours ---------------------------------------------------------------
  -- 'roster'       : the requirement stays derived day by day from the shift and
  --                  the calendar; monthly_hours is the stated norm shown beside
  --                  it. September 2026 genuinely works out to 225h, October to
  --                  243h, because the months differ.
  -- 'fixed_monthly': the month requires exactly monthly_hours whatever the
  --                  calendar says. Predictable, and wrong for part-months.
  hours_basis   ENUM('roster','fixed_monthly') NOT NULL DEFAULT 'roster',
  monthly_hours DECIMAL(6,2) NULL COMMENT 'e.g. 225.00',
  -- Under hours_basis=roster this is a CHECK, not a definition: week offs are
  -- defined by shifts.working_days, and two things defining them is how they
  -- start disagreeing.
  week_offs_per_month TINYINT UNSIGNED NULL,
  default_shift_id    INT NULL COMMENT 'Reference, never a copy of the shift fields',

  -- ---- What counts as a day ------------------------------------------------
  min_hours_full_day  DECIMAL(4,2) NULL COMMENT 'Below this the day is half',
  min_hours_half_day  DECIMAL(4,2) NULL COMMENT 'Below this the day is absent',
  late_grace_minutes  SMALLINT UNSIGNED NULL COMMENT 'Overrides the shift grace when set',
  overtime_after_minutes SMALLINT UNSIGNED NULL,
  overtime_multiplier DECIMAL(4,2) NULL,

  -- ---- Leave and permission ------------------------------------------------
  casual_leave_days   DECIMAL(5,1) NULL,
  sick_leave_days     DECIMAL(5,1) NULL,
  earned_leave_days   DECIMAL(5,1) NULL,
  carry_forward_days  DECIMAL(5,1) NULL,
  permission_hours_per_month DECIMAL(4,2) NULL,

  -- ---- Statutory -----------------------------------------------------------
  -- Deliberately NOT salary, CTC or pay rates: this stays an attendance system
  -- whose output supports payroll, not a payroll system with weaker controls.
  pf_applicable                TINYINT(1) NOT NULL DEFAULT 0,
  esi_applicable               TINYINT(1) NOT NULL DEFAULT 0,
  professional_tax_applicable  TINYINT(1) NOT NULL DEFAULT 0,
  income_tax_tds_applicable    TINYINT(1) NOT NULL DEFAULT 0,
  gratuity_applicable          TINYINT(1) NOT NULL DEFAULT 0,
  lwf_applicable               TINYINT(1) NOT NULL DEFAULT 0,
  bonus_applicable             TINYINT(1) NOT NULL DEFAULT 0,

  -- ---- Employment terms ----------------------------------------------------
  probation_months    TINYINT UNSIGNED NULL,
  notice_period_days  SMALLINT UNSIGNED NULL,

  -- ---- Scoring weights -----------------------------------------------------
  -- So one policy can value punctuality and another can value hours delivered.
  score_weight_attendance  TINYINT UNSIGNED NOT NULL DEFAULT 40,
  score_weight_punctuality TINYINT UNSIGNED NOT NULL DEFAULT 30,
  score_weight_hours       TINYINT UNSIGNED NOT NULL DEFAULT 30,

  created_by  INT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_policy_code (code),
  KEY idx_policy_active (is_active),
  CONSTRAINT fk_policy_shift   FOREIGN KEY (default_shift_id) REFERENCES shifts(id)    ON DELETE SET NULL,
  CONSTRAINT fk_policy_creator FOREIGN KEY (created_by)       REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS employee_policies (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT  NOT NULL,
  policy_id      INT  NOT NULL,
  effective_from DATE NOT NULL,
  -- NULL = still in force. Shaped like employee_schedules so the same mental
  -- model and the same "in force on this date" test apply to both.
  effective_to   DATE NULL,
  assigned_by    INT NULL,
  notes          VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_emp_policy_lookup (employee_id, effective_from, effective_to),
  KEY idx_emp_policy_policy (policy_id),
  CONSTRAINT fk_ep_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_ep_policy   FOREIGN KEY (policy_id)   REFERENCES policies(id)  ON DELETE CASCADE,
  CONSTRAINT fk_ep_assigner FOREIGN KEY (assigned_by) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- Document types: add the government-ID kinds.
--
-- Adding values to an ENUM is additive - existing rows keep their values and
-- nothing is rewritten. Guarded so a re-run is a no-op.
-- ---------------------------------------------------------------------------
SET @has_gov := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'employee_documents'
     AND COLUMN_NAME = 'doc_type'
     AND COLUMN_TYPE LIKE '%government_id%'
);

SET @sql := IF(
  @has_gov = 0,
  'ALTER TABLE employee_documents MODIFY COLUMN doc_type
     ENUM(''pan_card'',''aadhaar_card'',''bank_proof'',''experience_certificate'',
          ''relieving_letter'',''education_certificate'',''offer_letter'',
          ''government_id'',''passport'',''driving_licence'',''voter_id'',''other'')
     NOT NULL DEFAULT ''other''',
  'SELECT ''employee_documents.doc_type already has the government-ID values'' AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT 'policies'          AS what, COUNT(*) AS table_present, 'must be 1' AS detail
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies';

SELECT 'employee_policies' AS what, COUNT(*) AS table_present, 'must be 1' AS detail
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_policies';

SELECT 'doc_type has government_id' AS what, COUNT(*) AS ok, 'must be 1' AS detail
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
   AND COLUMN_NAME = 'doc_type' AND COLUMN_TYPE LIKE '%government_id%';

SELECT 'employees under a policy' AS what,
       COUNT(*) AS assigned,
       '0 right after this migration - every employee keeps todays behaviour' AS detail
  FROM employee_policies WHERE effective_to IS NULL;
