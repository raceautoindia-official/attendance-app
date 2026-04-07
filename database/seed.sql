-- =============================================================================
-- Attendance App — Seed Data
-- Run after schema.sql.
-- PIN hashes generated with bcrypt, cost factor 12.
--   ADMIN001 → PIN 000000
--   MGR001   → PIN 111111
--   EMP001   → PIN 123456
--   EMP002   → PIN 123456
-- =============================================================================

USE attendance_db;

-- ---------------------------------------------------------------------------
-- -- employees
-- -- ---------------------------------------------------------------------------
INSERT INTO employees
  (emp_id, name, email, phone, pin_hash, role, is_active, manager_id)
VALUES
  (
    'ADMIN001',
    'Super Admin',
    'admin@company.com',
    NULL,
    '$2b$12$l3.u0oTGfAVapllBd4U2ZeV.3dr6Ki3IoTynFd/OC/CrpcjTEmIDy',
    'super_admin',
    TRUE,
    NULL
  ),
  (
    'MGR001',
    'Test Manager',
    'manager@company.com',
    NULL,
    '$2b$12$M60ClJTAZQeu7/kST3A34OnZAkLstf1BX67KVXJEDVc3uhK8ZDRLW',
    'manager',
    TRUE,
    1   -- managed by ADMIN001 (id = 1)
  ),
  (
    'EMP001',
    'Test Employee One',
    'emp001@company.com',
    NULL,
    '$2b$12$UASDLbDiJDXmYMEbUvATj.LTEsHuXIaudvDl5efwz9myDzvJq6SL2',
    'employee',
    TRUE,
    2   -- managed by MGR001 (id = 2)
  ),
  (
    'EMP002',
    'Test Employee Two',
    'emp002@company.com',
    NULL,
    '$2b$12$UASDLbDiJDXmYMEbUvATj.LTEsHuXIaudvDl5efwz9myDzvJq6SL2',
    'employee',
    TRUE,
    2   -- managed by MGR001 (id = 2)
  );

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------
INSERT INTO locations
  (name, address, latitude, longitude, radius_meters, is_active)
VALUES
  (
    'Head Office',
    'Chennai, Tamil Nadu, India',
    13.0827000,
    80.2707000,
    200,
    TRUE
  );

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
INSERT INTO shifts
  (name, type, start_time, end_time, required_hours, grace_minutes, working_days, rotation_config, created_by)
VALUES
  (
    'General Shift',
    'fixed',
    '09:00:00',
    '18:00:00',
    NULL,
    10,
    '["Mon","Tue","Wed","Thu","Fri","Sat"]',
    NULL,
    1   -- created by ADMIN001
  );

-- ---------------------------------------------------------------------------
-- employee_schedules — assign all employees to General Shift / Head Office
-- ---------------------------------------------------------------------------
INSERT INTO employee_schedules
  (employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
VALUES
  (1, 1, 1, FALSE, CURDATE(), NULL, 1),
  (2, 1, 1, FALSE, CURDATE(), NULL, 1),
  (3, 1, 1, FALSE, CURDATE(), NULL, 1),
  (4, 1, 1, FALSE, CURDATE(), NULL, 1);

-- ---------------------------------------------------------------------------
-- passkey_exemptions
-- Seed users have no passkey registered yet, so they need a PIN-only
-- exemption to be able to log in locally and then enroll a passkey.
-- All exemptions are granted by ADMIN001 (id = 1).
-- ---------------------------------------------------------------------------
INSERT INTO passkey_exemptions
  (employee_id, granted_by, reason, is_active)
VALUES
  (1, 1, 'Seed account — initial local access before passkey enrolment', TRUE),
  (2, 1, 'Seed account — initial local access before passkey enrolment', TRUE),
  (3, 1, 'Seed account — initial local access before passkey enrolment', TRUE),
  (4, 1, 'Seed account — initial local access before passkey enrolment', TRUE);
