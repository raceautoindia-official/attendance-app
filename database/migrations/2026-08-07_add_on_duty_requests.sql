-- =============================================================================
-- 2026-08-07 — On-duty (official work outside the fence)
--
-- permission_requests gains a type. The two are handled very differently:
--
--   'permission'  Short paid TIME OFF inside a working day (bank work, doctor).
--                 Consumes the monthly permission quota and TOPS UP the day's
--                 hours to the shift length.
--
--   'on_duty'     The employee IS working, just not at the work site (client
--                 visit, delivery, site inspection). Does NOT touch the
--                 permission quota and adds NO credited minutes — their real
--                 clocked hours already count. Once approved, the geofence must
--                 NOT clock them out while they are away.
--
-- Existing rows are all time-off requests, so the default preserves them.
--
-- Not idempotent — run once.
-- =============================================================================

ALTER TABLE permission_requests
  ADD COLUMN request_type ENUM('permission','on_duty') NOT NULL DEFAULT 'permission'
    AFTER employee_id;

-- The geofence watchdog asks "is this employee on approved duty right now?" on
-- every sweep, so make that lookup cheap.
ALTER TABLE permission_requests
  ADD INDEX idx_permission_requests_type_date (request_type, status, permission_date);
