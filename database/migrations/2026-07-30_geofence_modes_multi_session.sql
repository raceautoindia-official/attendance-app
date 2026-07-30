-- =============================================================================
-- 2026-07-30 — On-site/off-site work modes and multi-session attendance
--
-- 1. employees.work_mode:
--      'on_site'  — geofence enforced: cannot clock in outside the fence
--                   (minimum 200 m), auto clock-out after 30 min outside.
--      'off_site' — field staff: clock in from anywhere, no geofence.
-- 2. employees.allow_multiple_sessions:
--      plant staff may clock in/out several times a day; hours accumulate.
-- 3. attendance.banked_minutes / session_count:
--      minutes finished in earlier sessions today and how many sessions.
--
-- The ALTERs are not idempotent — run once.
-- =============================================================================

ALTER TABLE employees
  ADD COLUMN work_mode ENUM('on_site','off_site') NOT NULL DEFAULT 'on_site' AFTER live_tracking_enabled,
  ADD COLUMN allow_multiple_sessions BOOLEAN NOT NULL DEFAULT FALSE AFTER work_mode;

ALTER TABLE attendance
  ADD COLUMN banked_minutes INT NOT NULL DEFAULT 0 AFTER total_minutes,
  ADD COLUMN session_count  INT NOT NULL DEFAULT 1 AFTER banked_minutes;
