-- =============================================================================
-- 2026-07-30 — One active live-tracking session per employee, enforced
--
-- Concurrent /start requests (phone app + web login, or parallel retries)
-- could each create a session, so an employee appeared twice on the admin
-- live map. Close the older duplicates, then add a uniqueness guarantee:
-- active_employee_id is the employee_id while the session is active and NULL
-- once ended, so the UNIQUE key only constrains active sessions.
--
-- The ALTER is not idempotent — run once. The UPDATE is safe to re-run.
-- =============================================================================

-- 1. Close all but the newest active session per employee
UPDATE live_tracking_sessions s
JOIN (
  SELECT employee_id, MAX(id) AS keep_id
  FROM live_tracking_sessions
  WHERE is_active = TRUE
  GROUP BY employee_id
) k ON k.employee_id = s.employee_id
SET s.is_active = FALSE, s.ended_at_utc = UTC_TIMESTAMP()
WHERE s.is_active = TRUE AND s.id <> k.keep_id;

-- 2. Make duplicates impossible from now on. VIRTUAL (not STORED) so the
--    table needs no rebuild — a STORED column trips MySQL's FK re-check
--    (errno 1215) because live_tracking_points references this table.
ALTER TABLE live_tracking_sessions
  ADD COLUMN active_employee_id INT GENERATED ALWAYS AS (IF(is_active, employee_id, NULL)) VIRTUAL,
  ADD UNIQUE KEY uq_live_tracking_sessions_active_emp (active_employee_id);
