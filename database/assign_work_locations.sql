-- =============================================================================
-- GIVE AN EMPLOYEE A WORK SITE
--
--   mysql --table -u <user> -p <database> < database/assign_work_locations.sql
--
-- Two people were left out of the fence rollout for reasons no flag could fix:
--
--   Subhashree (RACE008) — no schedule at all, though her phone reports fine
--   Manoj.P    (RACE004) — has a schedule, but no work location on it
--
-- A fence needs coordinates, and coordinates come from a schedule pointing at
-- an active location. This creates the Erode site, puts Subhashree on it, and
-- points Manoj at the Chennai office.
--
-- IT DOES NOT ARM ANYBODY. Whether a fence is switched on depends on whether
-- that person's phone actually reports, and enable_auto_logout.sql is the one
-- place that decides it — for everyone, by one rule. Run this first, that
-- second. Manoj's phone has never reported, so it will (correctly) leave him
-- unarmed until it does.
--
-- Safe to re-run: every step checks for itself first.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- --- the new site -----------------------------------------------------------
-- 11°21'13.5"N 77°43'40.1"E in decimal. RENAME THIS if the site is known by
-- something else: the name appears in reports and in the notification an
-- employee sees when they are clocked out.
SET @site_name   := 'Race Auto India - Erode';
SET @site_lat    := 11.3537500;
SET @site_lng    := 77.7278056;
-- 200 m matches the Chennai office. Smaller than about 75 m starts clocking
-- people out at their own desk, because indoor GPS drifts that far by itself.
SET @site_radius := 200;

-- --- who goes where ---------------------------------------------------------
SET @erode_emp   := 'RACE008';   -- Subhashree -> the new Erode site
SET @office_emp  := 'RACE004';   -- Manoj.P    -> the existing Chennai office
SET @office_like := 'Butt Road'; -- how to find that office by name


-- 1. CREATE THE SITE ----------------------------------------------------------
INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
SELECT @site_name, 'Erode, Tamil Nadu', @site_lat, @site_lng, @site_radius, TRUE
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM locations WHERE name = @site_name);

SET @erode_loc  := (SELECT id FROM locations WHERE name = @site_name LIMIT 1);
SET @office_loc := (SELECT id FROM locations
                     WHERE is_active = TRUE AND name LIKE CONCAT('%', @office_like, '%')
                     ORDER BY id LIMIT 1);

SELECT @erode_loc AS erode_location_id, @office_loc AS office_location_id,
       IF(@office_loc IS NULL,
          'STOP: no active location matches @office_like — fix that before reading on',
          'both sites resolved') AS status;


-- 2. THE SHIFT TO PUT THEM ON -------------------------------------------------
-- Whichever shift most of the current schedules already use, so a new starter
-- inherits the ordinary working day rather than an arbitrary one. The shift
-- decides their expected hours and when they count as late, so check the name
-- below is the one you meant.
SET @shift_id := (
  SELECT es.shift_id
  FROM employee_schedules es
  JOIN employees e ON e.id = es.employee_id AND e.is_active = TRUE
  WHERE es.effective_from <= CURDATE()
    AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
  GROUP BY es.shift_id
  ORDER BY COUNT(*) DESC, es.shift_id
  LIMIT 1);

SELECT s.id AS shift_id, s.name AS shift_name, s.start_time, s.end_time, s.required_hours
FROM shifts s WHERE s.id = @shift_id;


-- 3. SUBHASHREE — no schedule at all, so create one ---------------------------
INSERT INTO employee_schedules (employee_id, shift_id, location_id, geofencing_enabled, effective_from)
SELECT e.id, @shift_id, @erode_loc, FALSE, CURDATE()
FROM employees e
WHERE e.emp_id = @erode_emp
  AND e.is_active = TRUE
  AND @erode_loc IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM employee_schedules es
     WHERE es.employee_id = e.id
       AND es.effective_from <= CURDATE()
       AND (es.effective_to IS NULL OR es.effective_to >= CURDATE()));


-- 4. MANOJ — has a schedule, just no location on it ---------------------------
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
SET es.location_id = @office_loc
WHERE e.emp_id = @office_emp
  AND e.is_active = TRUE
  AND es.location_id IS NULL
  AND @office_loc IS NOT NULL
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE());


-- 5. BOTH MUST BE ON-SITE STAFF FOR A FENCE TO MEAN ANYTHING ------------------
UPDATE employees
SET work_mode = 'on_site'
WHERE emp_id IN (@erode_emp, @office_emp)
  AND is_active = TRUE
  AND (work_mode IS NULL OR work_mode <> 'on_site');


-- 6. WHAT THEY LOOK LIKE NOW --------------------------------------------------
SELECT e.emp_id, e.name,
       COALESCE(e.work_mode, 'unset')                 AS work_mode,
       COALESCE(l.name, '— still none —')             AS site,
       l.radius_meters                                AS fence_m,
       es.geofencing_enabled                          AS armed,
       COALESCE(CONCAT(TIMESTAMPDIFF(HOUR, lp.last_ping, UTC_TIMESTAMP()), ' h ago'),
                'NEVER')                              AS phone_last_reported,
       CASE
         WHEN es.id IS NULL          THEN 'FAILED: still no schedule'
         WHEN es.location_id IS NULL THEN 'FAILED: still no location'
         WHEN lp.last_ping IS NULL
           OR lp.last_ping < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
                                     THEN 'site set — phone must report before arming'
         ELSE 'ready — run enable_auto_logout.sql to arm'
       END                                            AS next_step
FROM employees e
LEFT JOIN employee_schedules es ON es.id = (
  SELECT id FROM employee_schedules
   WHERE employee_id = e.id AND effective_from <= CURDATE()
     AND (effective_to IS NULL OR effective_to >= CURDATE())
   ORDER BY effective_from DESC, id DESC LIMIT 1)
LEFT JOIN locations l ON l.id = es.location_id
LEFT JOIN (
  SELECT employee_id, MAX(tracked_at_utc) AS last_ping
  FROM live_tracking_points
  WHERE tracked_at_utc >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY employee_id
) lp ON lp.employee_id = e.id
WHERE e.emp_id IN (@erode_emp, @office_emp);


-- 7. EVERY ACTIVE SITE, FOR A SANITY CHECK ------------------------------------
SELECT id, name, latitude, longitude, radius_meters
FROM locations WHERE is_active = TRUE ORDER BY id;
