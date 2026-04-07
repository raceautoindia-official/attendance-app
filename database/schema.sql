-- =============================================================================
-- Attendance App — MySQL 8 Schema
-- All DATETIME columns store UTC.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS attendance_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE attendance_db;

-- ---------------------------------------------------------------------------
-- 1. employees
-- ---------------------------------------------------------------------------
CREATE TABLE employees (
  id          INT            NOT NULL AUTO_INCREMENT,
  emp_id      VARCHAR(20)    NOT NULL,
  name        VARCHAR(100)   NOT NULL,
  email       VARCHAR(150)   NULL,
  phone       VARCHAR(20)    NULL,
  pin_hash    VARCHAR(255)   NOT NULL,
  role        ENUM('employee','manager','super_admin') NOT NULL DEFAULT 'employee',
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  manager_id  INT            NULL,
  created_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_emp_id (emp_id),
  UNIQUE KEY uq_employees_email  (email),
  INDEX idx_employees_manager_id (manager_id),
  INDEX idx_employees_role       (role),
  INDEX idx_employees_is_active  (is_active),

  CONSTRAINT fk_employees_manager
    FOREIGN KEY (manager_id) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. passkeys
-- ---------------------------------------------------------------------------
CREATE TABLE passkeys (
  id             INT           NOT NULL AUTO_INCREMENT,
  employee_id    INT           NOT NULL,
  credential_id  VARCHAR(500)  NOT NULL,
  public_key     TEXT          NOT NULL,
  counter        BIGINT        NOT NULL DEFAULT 0,
  device_name    VARCHAR(100)  NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME      NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_passkeys_credential_id (credential_id),
  INDEX idx_passkeys_employee_id (employee_id),

  CONSTRAINT fk_passkeys_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. passkey_exemptions
-- ---------------------------------------------------------------------------
CREATE TABLE passkey_exemptions (
  id           INT      NOT NULL AUTO_INCREMENT,
  employee_id  INT      NOT NULL,
  granted_by   INT      NOT NULL,
  reason       TEXT     NULL,
  is_active    BOOLEAN  NOT NULL DEFAULT TRUE,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_passkey_exemptions_employee_id (employee_id),
  INDEX idx_passkey_exemptions_granted_by  (granted_by),
  INDEX idx_passkey_exemptions_is_active   (is_active),

  CONSTRAINT fk_passkey_exemptions_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_passkey_exemptions_granted_by
    FOREIGN KEY (granted_by) REFERENCES employees (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. refresh_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id           INT          NOT NULL AUTO_INCREMENT,
  employee_id  INT          NOT NULL,
  token_hash   VARCHAR(255) NOT NULL,
  expires_at   DATETIME     NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_refresh_tokens_employee_id (employee_id),
  INDEX idx_refresh_tokens_token_hash  (token_hash),
  INDEX idx_refresh_tokens_expires_at  (expires_at),

  CONSTRAINT fk_refresh_tokens_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. locations
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
  id             INT            NOT NULL AUTO_INCREMENT,
  name           VARCHAR(100)   NOT NULL,
  address        TEXT           NULL,
  latitude       DECIMAL(10,7)  NOT NULL,
  longitude      DECIMAL(10,7)  NOT NULL,
  radius_meters  INT            NOT NULL DEFAULT 100,
  is_active      BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_locations_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. shifts
-- ---------------------------------------------------------------------------
CREATE TABLE shifts (
  id               INT                                           NOT NULL AUTO_INCREMENT,
  name             VARCHAR(100)                                  NOT NULL,
  type             ENUM('fixed','flexible','rotating','custom')  NOT NULL,
  start_time       TIME                                          NULL,
  end_time         TIME                                          NULL,
  required_hours   DECIMAL(4,2)                                  NULL,
  grace_minutes    INT                                           NOT NULL DEFAULT 10,
  working_days     JSON                                          NOT NULL,
  rotation_config  JSON                                          NULL,
  created_by       INT                                           NULL,
  created_at       DATETIME                                      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_shifts_created_by (created_by),
  INDEX idx_shifts_type       (type),

  CONSTRAINT fk_shifts_created_by
    FOREIGN KEY (created_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. employee_schedules
-- ---------------------------------------------------------------------------
CREATE TABLE employee_schedules (
  id                  INT      NOT NULL AUTO_INCREMENT,
  employee_id         INT      NOT NULL,
  shift_id            INT      NOT NULL,
  location_id         INT      NULL,
  geofencing_enabled  BOOLEAN  NOT NULL DEFAULT FALSE,
  effective_from      DATE     NOT NULL,
  effective_to        DATE     NULL,
  assigned_by         INT      NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_employee_schedules_employee_id    (employee_id),
  INDEX idx_employee_schedules_shift_id       (shift_id),
  INDEX idx_employee_schedules_location_id    (location_id),
  INDEX idx_employee_schedules_effective_from (effective_from),
  INDEX idx_employee_schedules_effective_to   (effective_to),

  CONSTRAINT fk_employee_schedules_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_employee_schedules_shift
    FOREIGN KEY (shift_id) REFERENCES shifts (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT fk_employee_schedules_location
    FOREIGN KEY (location_id) REFERENCES locations (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_employee_schedules_assigned_by
    FOREIGN KEY (assigned_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. attendance
-- ---------------------------------------------------------------------------
CREATE TABLE attendance (
  id               BIGINT         NOT NULL AUTO_INCREMENT,
  employee_id      INT            NOT NULL,
  work_date        DATE           NOT NULL,
  clock_in_utc     DATETIME       NULL,
  clock_out_utc    DATETIME       NULL,
  clock_in_lat     DECIMAL(10,7)  NULL,
  clock_in_lng     DECIMAL(10,7)  NULL,
  clock_out_lat    DECIMAL(10,7)  NULL,
  clock_out_lng    DECIMAL(10,7)  NULL,
  ip_address       VARCHAR(45)    NULL,
  geofence_status  ENUM('inside','outside','not_required') NOT NULL DEFAULT 'not_required',
  auth_method      ENUM('webauthn','pin_exemption')        NOT NULL,
  total_minutes    INT            NULL,
  status           ENUM('present','late','early_departure','absent','leave','holiday') NOT NULL DEFAULT 'present',
  notes            TEXT           NULL,
  edited_by        INT            NULL,
  edited_at        DATETIME       NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_emp_date (employee_id, work_date),
  INDEX idx_attendance_work_date    (work_date),
  INDEX idx_attendance_employee_id  (employee_id),
  INDEX idx_attendance_status       (status),
  INDEX idx_attendance_edited_by    (edited_by),

  CONSTRAINT fk_attendance_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,

  CONSTRAINT fk_attendance_edited_by
    FOREIGN KEY (edited_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 9. leave_records
-- ---------------------------------------------------------------------------
CREATE TABLE leave_records (
  id           INT          NOT NULL AUTO_INCREMENT,
  employee_id  INT          NULL,
  leave_date   DATE         NOT NULL,
  leave_type   ENUM('casual','sick','earned','holiday','other') NOT NULL,
  notes        VARCHAR(500) NULL,
  created_by   INT          NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_leave_records_employee_id (employee_id),
  INDEX idx_leave_records_leave_date  (leave_date),
  INDEX idx_leave_records_type        (leave_type),

  CONSTRAINT fk_leave_records_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_leave_records_created_by
    FOREIGN KEY (created_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 10. audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  action        VARCHAR(100) NOT NULL,
  entity        VARCHAR(50)  NOT NULL,
  entity_id     INT          NULL,
  performed_by  INT          NULL,
  details       JSON         NULL,
  ip_address    VARCHAR(45)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_audit_log_performed_by (performed_by),
  INDEX idx_audit_log_created_at   (created_at),
  INDEX idx_audit_log_entity       (entity, entity_id),

  CONSTRAINT fk_audit_log_performed_by
    FOREIGN KEY (performed_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
