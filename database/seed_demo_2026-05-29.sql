USE attendance;

-- Demo seed for validating:
-- 1) Employee create + schedule
-- 2) Daily work updates
-- 3) Live tracking
-- 4) Leaves and company holiday
-- 5) Last-7-days attendance visibility
-- 6) Optional login photo-proof table path

-- ---------------------------------------------------------------------------
-- Ensure required migration-backed tables exist first:
--   1) database/migrations/2026-05-29_add_login_photo_and_daily_updates.sql
-- Then run this demo seed file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Ensure admin + manager exist for ownership/scoping
-- ---------------------------------------------------------------------------
INSERT INTO employees (emp_id, name, email, phone, department, pin_hash, role, is_active, manager_id)
SELECT 'ADMIN001', 'Super Admin', 'admin@company.com', NULL, 'Admin', '$2b$12$l3.u0oTGfAVapllBd4U2ZeV.3dr6Ki3IoTynFd/OC/CrpcjTEmIDy', 'super_admin', TRUE, NULL
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE emp_id = 'ADMIN001');

INSERT INTO employees (emp_id, name, email, phone, department, pin_hash, role, is_active, manager_id)
SELECT 'MGR001', 'Test Manager', 'manager@company.com', NULL, 'Operations', '$2b$12$M60ClJTAZQeu7/kST3A34OnZAkLstf1BX67KVXJEDVc3uhK8ZDRLW', 'manager', TRUE, (SELECT id FROM employees WHERE emp_id = 'ADMIN001' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE emp_id = 'MGR001');

-- ---------------------------------------------------------------------------
-- Demo employee: Reena
-- PIN: 123456
-- ---------------------------------------------------------------------------
INSERT INTO employees (emp_id, name, email, phone, department, pin_hash, role, is_active, manager_id)
SELECT
  'REENA001',
  'Reena',
  'reena@company.com',
  '9000000001',
  'Field',
  '$2b$12$UASDLbDiJDXmYMEbUvATj.LTEsHuXIaudvDl5efwz9myDzvJq6SL2',
  'employee',
  TRUE,
  (SELECT id FROM employees WHERE emp_id = 'MGR001' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE emp_id = 'REENA001');

-- Ensure PIN exemption for first-login local flow
INSERT INTO passkey_exemptions (employee_id, granted_by, reason, is_active)
SELECT e.id, a.id, 'Demo local access before passkey enrolment', TRUE
FROM employees e
JOIN employees a ON a.emp_id = 'ADMIN001'
WHERE e.emp_id = 'REENA001'
  AND NOT EXISTS (
    SELECT 1
    FROM passkey_exemptions pe
    WHERE pe.employee_id = e.id
      AND pe.is_active = TRUE
  );

-- ---------------------------------------------------------------------------
-- Locations + shifts
-- ---------------------------------------------------------------------------
INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
SELECT 'Head Office', 'Chennai, Tamil Nadu, India', 13.0827000, 80.2707000, 200, TRUE
WHERE NOT EXISTS (SELECT 1 FROM locations WHERE name = 'Head Office');

INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
SELECT 'Client Site A', 'Ekkatuthangal, Chennai', 13.0079900, 80.1969800, 150, TRUE
WHERE NOT EXISTS (SELECT 1 FROM locations WHERE name = 'Client Site A');

INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days, rotation_config, created_by)
SELECT
  'General Shift',
  'fixed',
  '09:00:00',
  '18:00:00',
  NULL,
  10,
  '["Mon","Tue","Wed","Thu","Fri","Sat"]',
  NULL,
  (SELECT id FROM employees WHERE emp_id = 'ADMIN001' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE name = 'General Shift');

INSERT INTO shifts (name, type, start_time, end_time, required_hours, grace_minutes, working_days, rotation_config, created_by)
SELECT
  'Field Flexible',
  'flexible',
  NULL,
  NULL,
  8.00,
  0,
  '["Mon","Tue","Wed","Thu","Fri","Sat"]',
  NULL,
  (SELECT id FROM employees WHERE emp_id = 'ADMIN001' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE name = 'Field Flexible');

-- Active schedule for Reena
INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from, effective_to, assigned_by)
SELECT
  e.id,
  s.id,
  l.id,
  TRUE,
  CURDATE() - INTERVAL 7 DAY,
  NULL,
  a.id
FROM employees e
JOIN shifts s ON s.name = 'Field Flexible'
JOIN locations l ON l.name = 'Client Site A'
JOIN employees a ON a.emp_id = 'ADMIN001'
WHERE e.emp_id = 'REENA001'
  AND NOT EXISTS (
    SELECT 1
    FROM employee_schedules es
    WHERE es.employee_id = e.id
      AND es.effective_to IS NULL
  );

-- ---------------------------------------------------------------------------
-- Company-wide holiday + one personal leave
-- ---------------------------------------------------------------------------
INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
SELECT NULL, CURDATE() - INTERVAL 2 DAY, 'holiday', 'Demo company holiday', (SELECT id FROM employees WHERE emp_id = 'ADMIN001' LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM leave_records lr
  WHERE lr.employee_id IS NULL
    AND lr.leave_date = CURDATE() - INTERVAL 2 DAY
);

INSERT INTO leave_records (employee_id, leave_date, leave_type, notes, created_by)
SELECT e.id, CURDATE() - INTERVAL 4 DAY, 'casual', 'Demo personal leave', (SELECT id FROM employees WHERE emp_id = 'MGR001' LIMIT 1)
FROM employees e
WHERE e.emp_id = 'REENA001'
  AND NOT EXISTS (
    SELECT 1 FROM leave_records lr
    WHERE lr.employee_id = e.id
      AND lr.leave_date = CURDATE() - INTERVAL 4 DAY
  );

-- ---------------------------------------------------------------------------
-- Attendance rows for last 7 days (demo)
-- ---------------------------------------------------------------------------
SET @reena_id = (SELECT id FROM employees WHERE emp_id = 'REENA001' LIMIT 1);

INSERT INTO attendance (employee_id, work_date, clock_in_utc, clock_out_utc, clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, ip_address, geofence_status, auth_method, total_minutes, status, notes)
SELECT @reena_id, CURDATE() - INTERVAL 1 DAY, UTC_TIMESTAMP() - INTERVAL 1 DAY - INTERVAL 9 HOUR, UTC_TIMESTAMP() - INTERVAL 1 DAY - INTERVAL 1 HOUR, 13.0083000, 80.1967810, 13.0083000, 80.1967810, '127.0.0.1', 'inside', 'pin_exemption', 480, 'present', 'Demo full day'
WHERE @reena_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM attendance WHERE employee_id = @reena_id AND work_date = CURDATE() - INTERVAL 1 DAY);

INSERT INTO attendance (employee_id, work_date, clock_in_utc, clock_out_utc, clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, ip_address, geofence_status, auth_method, total_minutes, status, notes)
SELECT @reena_id, CURDATE() - INTERVAL 3 DAY, UTC_TIMESTAMP() - INTERVAL 3 DAY - INTERVAL 8 HOUR - INTERVAL 45 MINUTE, UTC_TIMESTAMP() - INTERVAL 3 DAY - INTERVAL 1 HOUR, 13.0083000, 80.1967810, 13.0083000, 80.1967810, '127.0.0.1', 'inside', 'pin_exemption', 465, 'late', 'Demo late day'
WHERE @reena_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM attendance WHERE employee_id = @reena_id AND work_date = CURDATE() - INTERVAL 3 DAY);

-- ---------------------------------------------------------------------------
-- Daily work updates for dashboard + admin overview
-- ---------------------------------------------------------------------------
INSERT INTO daily_work_updates (employee_id, work_date, update_text)
SELECT @reena_id, CURDATE(), 'Visited client site, completed audit checklist, and submitted documentation.'
WHERE @reena_id IS NOT NULL
ON DUPLICATE KEY UPDATE update_text = VALUES(update_text), updated_at = CURRENT_TIMESTAMP;

INSERT INTO daily_work_updates (employee_id, work_date, update_text)
SELECT @reena_id, CURDATE() - INTERVAL 1 DAY, 'Resolved attendance sync issue and updated geofence test logs.'
WHERE @reena_id IS NOT NULL
ON DUPLICATE KEY UPDATE update_text = VALUES(update_text), updated_at = CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- Optional demo artifacts for new features
-- ---------------------------------------------------------------------------
INSERT INTO login_photo_proofs (employee_id, image_data)
SELECT @reena_id, 'data:image/png;base64,DEMO_PLACEHOLDER'
WHERE @reena_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM login_photo_proofs lp
    WHERE lp.employee_id = @reena_id
  );

-- Simulate active live-tracking session + latest point
INSERT INTO live_tracking_sessions (employee_id, started_at_utc, ended_at_utc, is_active, last_ping_utc)
SELECT @reena_id, UTC_TIMESTAMP() - INTERVAL 20 MINUTE, NULL, TRUE, UTC_TIMESTAMP()
WHERE @reena_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM live_tracking_sessions s
    WHERE s.employee_id = @reena_id
      AND s.is_active = TRUE
  );

SET @session_id = (
  SELECT id
  FROM live_tracking_sessions
  WHERE employee_id = @reena_id AND is_active = TRUE
  ORDER BY started_at_utc DESC
  LIMIT 1
);

INSERT INTO live_tracking_points (session_id, employee_id, tracked_at_utc, latitude, longitude, accuracy_meters)
SELECT @session_id, @reena_id, UTC_TIMESTAMP(), 13.0083000, 80.1967810, 12.00
WHERE @session_id IS NOT NULL;
