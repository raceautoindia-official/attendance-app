-- =============================================================================
-- catch-up-idempotent.sql — bring any attendance database up to date, safely.
--
--   mysql -u <user> -p <database> < catch-up-idempotent.sql
--
-- or paste it into a session that has already selected the database:
--   mysql -u <user> -p
--   USE your_database_name;
--   ...paste...
--
-- WHY THIS EXISTS
-- ---------------
-- The individual migration files use plain ALTER TABLE, which fails if the
-- change is already present — so running them against a partly-migrated database
-- stops halfway. Every step here checks INFORMATION_SCHEMA first and skips what
-- is already applied, so the whole file is safe to run repeatedly and in any
-- state. It prints a line per step saying what it did.
--
-- It contains no DROP and no DELETE. The only data it changes are two repairs,
-- both narrowly scoped and described at their step.
--
-- BACK UP FIRST:
--   mysqldump -u <user> -p --single-transaction --routines --triggers \
--     --databases <database> > backup-before-catchup.sql
-- =============================================================================

SELECT CONCAT('Target database: ', DATABASE()) AS ' ';

-- Helper pattern used throughout: build the statement only if it is needed,
-- otherwise run a harmless SELECT that reports the skip.
-- (MySQL has no "ADD COLUMN IF NOT EXISTS", hence the prepared statements.)

-- ---------------------------------------------------------------------------
-- 1. webauthn_challenges table            (2026-05-28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  emp_id      VARCHAR(20)  NOT NULL,
  challenge   VARCHAR(255) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (emp_id),
  INDEX idx_webauthn_challenges_created_at (created_at),
  CONSTRAINT fk_webauthn_challenges_employee
    FOREIGN KEY (emp_id) REFERENCES employees (emp_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SELECT '1. webauthn_challenges ................ ensured' AS step;

-- ---------------------------------------------------------------------------
-- 2. attendance.auth_method must be NULLABLE   (2026-06-03)
--
-- IMPORTANT: while this column is NOT NULL with no DEFAULT, every row inserted
-- by markAbsentees / markSundayHolidays (which omit it) silently gets the FIRST
-- enum value, 'webauthn'. Absent days and Sunday week-offs then claim a passkey
-- authentication that never happened, and auth_method is shown in the admin
-- table and both exported reports.
-- ---------------------------------------------------------------------------
SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance'
    AND COLUMN_NAME = 'auth_method' AND IS_NULLABLE = 'NO');
SET @sql := IF(@need > 0,
  'ALTER TABLE attendance MODIFY auth_method ENUM(''webauthn'',''pin_exemption'') NULL',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need > 0,
  '2. attendance.auth_method ............. made NULLABLE',
  '2. attendance.auth_method ............. already NULLABLE') AS step;

-- ---------------------------------------------------------------------------
-- 3. DATA REPAIR: clear the fabricated auth_method values.
--
-- Scope: rows with NO clock-in whose status is absent / holiday / leave. A row
-- WITH a clock-in came from a real authentication and is left untouched.
-- Idempotent. Review the count printed below before and after.
-- ---------------------------------------------------------------------------
SELECT CONCAT('3. rows to repair ..................... ', COUNT(*)) AS step
FROM attendance
WHERE clock_in_utc IS NULL AND auth_method IS NOT NULL
  AND status IN ('absent','holiday','leave');

UPDATE attendance SET auth_method = NULL
 WHERE clock_in_utc IS NULL AND auth_method IS NOT NULL
   AND status IN ('absent','holiday','leave');

SELECT CONCAT('3. rows still mislabelled (want 0) .... ', COUNT(*)) AS step
FROM attendance
WHERE clock_in_utc IS NULL AND auth_method IS NOT NULL
  AND status IN ('absent','holiday','leave');

SELECT CONCAT('3. real logins wrongly cleared (want 0) ', COUNT(*)) AS step
FROM attendance
WHERE clock_in_utc IS NOT NULL AND auth_method IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Employee bank / statutory identity columns   (2026-07-23)
-- ---------------------------------------------------------------------------
SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
    AND COLUMN_NAME = 'bank_account_number');
SET @sql := IF(@need = 0,
  'ALTER TABLE employees
     ADD COLUMN bank_account_name   VARCHAR(100) NULL AFTER department,
     ADD COLUMN bank_account_number VARCHAR(24)  NULL AFTER bank_account_name,
     ADD COLUMN bank_ifsc           VARCHAR(11)  NULL AFTER bank_account_number,
     ADD COLUMN bank_name           VARCHAR(100) NULL AFTER bank_ifsc,
     ADD COLUMN pan_number          VARCHAR(10)  NULL AFTER bank_name,
     ADD COLUMN aadhaar_number      VARCHAR(12)  NULL AFTER pan_number',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '4. employees bank/ID columns .......... added',
                     '4. employees bank/ID columns .......... already present') AS step;

CREATE TABLE IF NOT EXISTS employee_documents (
  id           INT           NOT NULL AUTO_INCREMENT,
  employee_id  INT           NOT NULL,
  doc_type     ENUM('pan_card','aadhaar_card','bank_proof','experience_certificate','relieving_letter','education_certificate','offer_letter','other') NOT NULL DEFAULT 'other',
  title        VARCHAR(150)  NOT NULL,
  file_name    VARCHAR(255)  NOT NULL,
  mime_type    VARCHAR(100)  NOT NULL,
  size_bytes   INT           NOT NULL,
  file_data    LONGTEXT      NOT NULL,
  uploaded_by  INT           NULL,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_employee_documents_employee_id (employee_id),
  INDEX idx_employee_documents_doc_type    (doc_type),
  CONSTRAINT fk_employee_documents_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_employee_documents_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES employees (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SELECT '4. employee_documents ................. ensured' AS step;

CREATE TABLE IF NOT EXISTS leave_quotas (
  id            INT       NOT NULL AUTO_INCREMENT,
  employee_id   INT       NOT NULL,
  year          SMALLINT  NOT NULL,
  casual_total  INT       NOT NULL DEFAULT 0,
  sick_total    INT       NOT NULL DEFAULT 0,
  earned_total  INT       NOT NULL DEFAULT 0,
  updated_by    INT       NULL,
  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_quotas_emp_year (employee_id, year),
  INDEX idx_leave_quotas_year (year),
  CONSTRAINT fk_leave_quotas_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_leave_quotas_updated_by
    FOREIGN KEY (updated_by) REFERENCES employees (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SELECT '4. leave_quotas ....................... ensured' AS step;

-- ---------------------------------------------------------------------------
-- 5. Work modes and multi-session attendance   (2026-07-30)
-- ---------------------------------------------------------------------------
SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'work_mode');
SET @sql := IF(@need = 0,
  'ALTER TABLE employees
     ADD COLUMN work_mode ENUM(''on_site'',''off_site'') NOT NULL DEFAULT ''on_site'' AFTER live_tracking_enabled,
     ADD COLUMN allow_multiple_sessions BOOLEAN NOT NULL DEFAULT FALSE AFTER work_mode',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '5. employees work_mode ................ added',
                     '5. employees work_mode ................ already present') AS step;

SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance' AND COLUMN_NAME = 'banked_minutes');
SET @sql := IF(@need = 0,
  'ALTER TABLE attendance
     ADD COLUMN banked_minutes INT NOT NULL DEFAULT 0 AFTER total_minutes,
     ADD COLUMN session_count  INT NOT NULL DEFAULT 1 AFTER banked_minutes',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '5. attendance banked_minutes .......... added',
                     '5. attendance banked_minutes .......... already present') AS step;

-- ---------------------------------------------------------------------------
-- 6. One active live-tracking session per employee   (2026-07-30)
-- Close older duplicates first, then add the guard.
-- VIRTUAL (not STORED): a STORED column trips MySQL's FK re-check, errno 1215.
-- ---------------------------------------------------------------------------
UPDATE live_tracking_sessions s
JOIN (SELECT employee_id, MAX(id) AS keep_id FROM live_tracking_sessions
       WHERE is_active = TRUE GROUP BY employee_id) k
  ON k.employee_id = s.employee_id
SET s.is_active = FALSE, s.ended_at_utc = UTC_TIMESTAMP()
WHERE s.is_active = TRUE AND s.id <> k.keep_id;

SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_tracking_sessions'
    AND COLUMN_NAME = 'active_employee_id');
SET @sql := IF(@need = 0,
  'ALTER TABLE live_tracking_sessions
     ADD COLUMN active_employee_id INT GENERATED ALWAYS AS (IF(is_active, employee_id, NULL)) VIRTUAL,
     ADD UNIQUE KEY uq_live_tracking_sessions_active_emp (active_employee_id)',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '6. one-active-session guard ........... added',
                     '6. one-active-session guard ........... already present') AS step;

-- ---------------------------------------------------------------------------
-- 7. DATA REPAIR: tracking points stamped before their session started.
-- Phones with a slow clock stamped fixes early, so the admin map showed
-- tracking "before login". started_at_utc is server-stamped, so any earlier
-- point is provably a clock artifact. Idempotent.
-- ---------------------------------------------------------------------------
UPDATE live_tracking_points p
JOIN live_tracking_sessions s ON s.id = p.session_id
SET p.tracked_at_utc = s.started_at_utc
WHERE p.tracked_at_utc < s.started_at_utc;
SELECT CONCAT('7. tracking points still early (want 0) ', COUNT(*)) AS step
FROM live_tracking_points p JOIN live_tracking_sessions s ON s.id = p.session_id
WHERE p.tracked_at_utc < s.started_at_utc;

-- ---------------------------------------------------------------------------
-- 8. Holiday calendar   (2026-10-03)
-- ---------------------------------------------------------------------------
SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'state_code');
SET @sql := IF(@need = 0,
  'ALTER TABLE locations ADD COLUMN state_code VARCHAR(5) NULL AFTER address', 'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '8. locations.state_code ............... added',
                     '8. locations.state_code ............... already present') AS step;

SET @need := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leave_records' AND COLUMN_NAME = 'location_id');
SET @sql := IF(@need = 0,
  'ALTER TABLE leave_records
     ADD COLUMN location_id INT NULL AFTER employee_id,
     ADD INDEX idx_leave_records_location (location_id),
     ADD CONSTRAINT fk_leave_records_location
       FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE ON UPDATE CASCADE',
  'DO 0');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
SELECT IF(@need = 0, '8. leave_records.location_id .......... added (NULL = all locations)',
                     '8. leave_records.location_id .......... already present') AS step;

-- state_key / location_key fold NULL so the UNIQUE keys actually dedupe:
-- MySQL treats NULLs in a unique index as distinct, so without them a re-import
-- duplicates every national holiday and ON DUPLICATE KEY UPDATE never fires.
CREATE TABLE IF NOT EXISTS holiday_calendar (
  id            INT           NOT NULL AUTO_INCREMENT,
  year          SMALLINT      NOT NULL,
  holiday_date  DATE          NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  holiday_type  ENUM('national','regional','company') NOT NULL DEFAULT 'national',
  state_code    VARCHAR(5)    NULL,
  needs_verification BOOLEAN  NOT NULL DEFAULT FALSE,
  source        ENUM('bundled','manual') NOT NULL DEFAULT 'bundled',
  notes         VARCHAR(500)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  state_key     VARCHAR(5) GENERATED ALWAYS AS (COALESCE(state_code, '-')) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_holiday_calendar (holiday_date, name, state_key),
  INDEX idx_holiday_calendar_year (year),
  INDEX idx_holiday_calendar_date (holiday_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SELECT '8. holiday_calendar ................... ensured' AS step;

CREATE TABLE IF NOT EXISTS holiday_observances (
  id           INT      NOT NULL AUTO_INCREMENT,
  holiday_id   INT      NOT NULL,
  location_id  INT      NULL,
  is_observed  BOOLEAN  NOT NULL DEFAULT FALSE,
  leave_record_id INT   NULL,
  decided_by   INT      NULL,
  decided_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  location_key INT GENERATED ALWAYS AS (COALESCE(location_id, 0)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_holiday_obs_nullsafe (holiday_id, location_key),
  INDEX idx_holiday_observances_location (location_id),
  CONSTRAINT fk_holiday_observances_holiday
    FOREIGN KEY (holiday_id) REFERENCES holiday_calendar (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_holiday_observances_location
    FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_holiday_observances_decided_by
    FOREIGN KEY (decided_by) REFERENCES employees (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SELECT '8. holiday_observances ................ ensured' AS step;

-- ---------------------------------------------------------------------------
-- Final state
-- ---------------------------------------------------------------------------
SELECT '--- DONE. Verify below. ---' AS step;

SELECT 'tables present' AS what,
  CONCAT(COUNT(*), '/6') AS result,
  GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) AS detail
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('webauthn_challenges','employee_documents','leave_quotas',
                     'holiday_calendar','holiday_observances','live_tracking_points');

SELECT 'columns present' AS what,
  CONCAT(COUNT(*), '/11') AS result,
  GROUP_CONCAT(CONCAT(TABLE_NAME,'.',COLUMN_NAME) ORDER BY TABLE_NAME, COLUMN_NAME) AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ((TABLE_NAME='employees'  AND COLUMN_NAME IN ('work_mode','allow_multiple_sessions','bank_account_number','pan_number','aadhaar_number'))
    OR (TABLE_NAME='attendance' AND COLUMN_NAME IN ('banked_minutes','session_count'))
    OR (TABLE_NAME='locations'  AND COLUMN_NAME='state_code')
    OR (TABLE_NAME='leave_records' AND COLUMN_NAME='location_id')
    OR (TABLE_NAME='holiday_calendar' AND COLUMN_NAME='state_key')
    OR (TABLE_NAME='holiday_observances' AND COLUMN_NAME='location_key'));

SELECT 'auth_method nullable' AS what, IS_NULLABLE AS result, 'must be YES' AS detail
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='attendance' AND COLUMN_NAME='auth_method';
