-- =============================================================================
-- TURN AUTO LOGOUT ON
--
--   mysql -u <user> -p <database> < database/enable_auto_logout.sql
--
-- Away-from-site auto clock-out needs FOUR things per employee. This sets all
-- four for everyone who already has a work location assigned, and lists anyone
-- it could not fix.
--
--   employees.work_mode             = 'on_site'
--   employees.live_tracking_enabled = TRUE
--   employee_schedules.location_id  -> an active location   (cannot be guessed)
--   employee_schedules.geofencing_enabled = TRUE
--
-- Safe to re-run. It never invents a location: an employee without one is
-- reported at the end rather than silently left half-configured.
-- =============================================================================

-- Narrow to ONE person (partial match on name or emp_id), or leave EMPTY to
-- cover everybody.
SET @who := '';   -- <<< e.g. 'RACE013' or 'reena', or '' for all


-- 1. BEFORE -------------------------------------------------------------------
SELECT COUNT(*) AS employees_with_auto_logout_working
FROM employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND e.work_mode = 'on_site'
  AND e.live_tracking_enabled = TRUE
  AND es.geofencing_enabled = TRUE;


-- 2. THE EMPLOYEE-LEVEL SWITCHES ----------------------------------------------
-- Only for staff who actually have a work site — field staff with no location
-- are left as they are.
UPDATE employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
SET e.work_mode = 'on_site',
    e.live_tracking_enabled = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'));


-- 3. THE FENCE ITSELF ---------------------------------------------------------
-- The one that is almost always the blocker: a location is assigned but the
-- geofencing flag was never ticked, so nothing is ever enforced.
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
SET es.geofencing_enabled = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'));


-- 4. AFTER --------------------------------------------------------------------
SELECT COUNT(*) AS employees_with_auto_logout_working
FROM employees e
JOIN employee_schedules es ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
JOIN locations l ON l.id = es.location_id AND l.is_active = TRUE
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND e.work_mode = 'on_site'
  AND e.live_tracking_enabled = TRUE
  AND es.geofencing_enabled = TRUE;


-- 5. WHO IS STILL NOT COVERED -------------------------------------------------
-- Almost always: no work location on their schedule. A fence needs coordinates,
-- so assign the site from Schedules -> Assign Schedule and it starts working.
SELECT e.emp_id, e.name,
       CASE
         WHEN es.id IS NULL              THEN 'no schedule at all'
         WHEN es.location_id IS NULL     THEN 'NO WORK LOCATION — assign one'
         WHEN l.is_active <> 1           THEN 'location is deactivated'
         WHEN e.work_mode <> 'on_site'   THEN 'marked off-site (field staff)'
         ELSE 'other'
       END AS why_not
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.is_active = TRUE
  AND e.role = 'employee'
  AND (@who = '' OR e.name LIKE CONCAT('%', @who, '%') OR e.emp_id LIKE CONCAT('%', @who, '%'))
  AND NOT (es.location_id IS NOT NULL AND l.is_active = 1
           AND e.work_mode = 'on_site' AND es.geofencing_enabled = 1)
ORDER BY why_not, e.emp_id;

-- Auto clock-out then happens within the grace period (30 minutes by default,
-- GEOFENCE_PRESENCE_GRACE_MIN) of the employee's presence no longer being
-- confirmed inside their fence. The server sweep runs every few minutes.
