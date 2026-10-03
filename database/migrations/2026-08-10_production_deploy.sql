-- =============================================================================
-- PRODUCTION DEPLOY — run this ONCE, BEFORE deploying the new code.
--
-- Bundles the five outstanding migrations:
--   2026-08-04_add_permission_requests.sql
--   2026-08-07_add_on_duty_requests.sql
--   2026-08-08_add_token_version.sql
--   2026-08-08_add_device_binding.sql
--   2026-08-08_repair_fence_without_location.sql
--
-- Every step is GUARDED: it checks whether the change is already present and
-- skips it if so. Running this twice is harmless, and a run that fails halfway
-- can simply be run again — you will not get "duplicate column" errors that
-- leave you unsure how much was applied.
--
-- ORDER MATTERS relative to the code deploy. Step 5 clears schedules that claim
-- a geofence but carry no location. The new clock-in route REFUSES those (a
-- fence it cannot evaluate must not read as a pass), so if the code goes out
-- first, those employees cannot clock in at all. Run this script first.
--
-- Usage:
--   mysql -u <user> -p <database> < 2026-08-10_production_deploy.sql
-- =============================================================================

-- Report what is about to change ---------------------------------------------
SELECT 'BEFORE' AS stage,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests') AS has_permission_requests,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
           AND COLUMN_NAME = 'request_type')                                     AS has_on_duty,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
           AND COLUMN_NAME = 'token_version')                                    AS has_token_version,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices')    AS has_device_binding,
       (SELECT COUNT(*) FROM employee_schedules
         WHERE geofencing_enabled = TRUE AND location_id IS NULL)                AS fence_without_location;


-- 1. Permission hours --------------------------------------------------------
-- Short paid time off inside a working day. Approved minutes top the day's
-- worked hours back up to the shift length:
--   credited = LEAST(worked + permission, GREATEST(worked, required))
CREATE TABLE IF NOT EXISTS permission_requests (
  id               INT          NOT NULL AUTO_INCREMENT,
  employee_id      INT          NOT NULL,
  permission_date  DATE         NOT NULL,
  start_time       TIME         NOT NULL,
  end_time         TIME         NOT NULL,
  minutes          INT          NOT NULL,
  reason           VARCHAR(500) NULL,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  requested_by     INT          NULL,
  reviewed_by      INT          NULL,
  reviewed_at      DATETIME     NULL,
  review_notes     VARCHAR(500) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_permission_requests_employee_date (employee_id, permission_date),
  INDEX idx_permission_requests_date          (permission_date),
  INDEX idx_permission_requests_status        (status),
  INDEX idx_permission_requests_reviewed_by   (reviewed_by),

  CONSTRAINT fk_permission_requests_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_permission_requests_requested_by
    FOREIGN KEY (requested_by) REFERENCES employees (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_permission_requests_reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 2. On duty -----------------------------------------------------------------
-- Official work away from the site. Unlike 'permission' it consumes no monthly
-- quota and adds no credited minutes (real clocked hours already count) — but
-- while approved, the geofence must NOT clock the employee out.
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
       AND COLUMN_NAME = 'request_type') = 0,
  'ALTER TABLE permission_requests
     ADD COLUMN request_type ENUM(''permission'',''on_duty'') NOT NULL DEFAULT ''permission''
     AFTER employee_id',
  'SELECT ''request_type already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The geofence watchdog asks "is this employee on approved duty right now?" on
-- every sweep, so make that lookup cheap.
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
       AND INDEX_NAME = 'idx_permission_requests_type_date') = 0,
  'ALTER TABLE permission_requests
     ADD INDEX idx_permission_requests_type_date (request_type, status, permission_date)',
  'SELECT ''on-duty index already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- 3. Token version -----------------------------------------------------------
-- Logging out deleted refresh tokens but left the ACCESS token usable until it
-- expired. Every access token now carries this number; logout bumps it and each
-- token issued earlier stops verifying at once.
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = 'token_version') = 0,
  'ALTER TABLE employees
     ADD COLUMN token_version INT NOT NULL DEFAULT 0
     COMMENT ''Bumped to invalidate all previously issued access tokens''',
  'SELECT ''token_version already present'' AS skipped'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- 4. Device binding ----------------------------------------------------------
-- "Mobile only" was read from the User-Agent, which the client chooses. The
-- first phone an employee clocks in from is remembered here; a different one is
-- refused until an admin releases it.
CREATE TABLE IF NOT EXISTS employee_devices (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   INT          NOT NULL,
  device_id     VARCHAR(128) NOT NULL,
  platform      VARCHAR(32)  NULL,
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at   DATETIME     NULL COMMENT 'Set when an admin unbinds it (new phone, lost device)',
  released_by   INT          NULL,
  UNIQUE KEY uniq_employee_device (employee_id, device_id),
  KEY idx_employee_active (employee_id, released_at),
  CONSTRAINT fk_devices_employee
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_released_by
    FOREIGN KEY (released_by) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 5. Repair: a fence with nothing to check against ---------------------------
-- geofencing_enabled = TRUE with location_id = NULL displayed as "fenced" while
-- the clock-in check skipped the fence entirely, so those employees could clock
-- in from anywhere. The new code REFUSES that combination rather than waving it
-- through, so these rows must be cleared or the people on them cannot clock in.
-- Nobody loses a fence they really had: these schedules never had one.
-- To give them a real fence, reassign the schedule WITH a location afterwards.
UPDATE employee_schedules
SET geofencing_enabled = FALSE
WHERE geofencing_enabled = TRUE
  AND location_id IS NULL;


-- Confirm the result ---------------------------------------------------------
SELECT 'AFTER' AS stage,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests') AS has_permission_requests,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permission_requests'
           AND COLUMN_NAME = 'request_type')                                     AS has_on_duty,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees'
           AND COLUMN_NAME = 'token_version')                                    AS has_token_version,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_devices')    AS has_device_binding,
       (SELECT COUNT(*) FROM employee_schedules
         WHERE geofencing_enabled = TRUE AND location_id IS NULL)                AS fence_without_location;

-- Every column above must read 1, and fence_without_location must read 0.
-- Anyone listed by the query below has had geofencing switched off because no
-- location was set — reassign their schedule WITH a location to fence them.
SELECT e.emp_id, e.name, s.name AS shift
FROM employee_schedules es
JOIN employees e ON e.id = es.employee_id
JOIN shifts s ON s.id = es.shift_id
WHERE es.geofencing_enabled = FALSE
  AND es.location_id IS NULL
  AND e.is_active = TRUE
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE());
