USE attendance;

ALTER TABLE employees
  ADD COLUMN live_tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active;

