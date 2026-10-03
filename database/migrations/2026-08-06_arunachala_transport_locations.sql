-- =============================================================================
-- 2026-08-06 — Attendance marking locations for the Arunachala Transport sites
--
--   Krishnana Mohan  → Arunachala Transport, Peapully, Kurnool
--   Ganesh           → Arunachala Transport, Kodad
--   Venkatasai       → Arunachala Transport, Kodad
--   Sasi             → Arunachala Transport, Hosur
--   Karthik          → Arunachala Transport, Hosur
--   Madhan           → Arunachala Transport, Hosur
--
-- !! BEFORE RUNNING !!
--   1. Fill in the LATITUDE / LONGITUDE for each site in STEP 1. Placeholders
--      are 0.0 and the script REFUSES to run while any remain (STEP 0 check).
--      Krishna Mohan's live-tracking fix on 2026-08-05 was 15.256049, 77.754821
--      — that is the Peapully site, pre-filled below; verify it before trusting it.
--   2. Confirm the emp_id for each employee in STEP 2. The names in the PDF are
--      matched by emp_id here, NOT by name, because names repeat (there are two
--      "Arun"s already). Run the SELECT in STEP 0 to find the right ids.
--   3. Take a backup:  mysqldump -u USER -p attendance_db > backup.sql
--
-- Re-runnable: locations are matched by name, schedules by employee.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 0 — Look up the employees first, then fill in STEP 2 accordingly.
-- Run this on its own and check the output before executing the rest.
-- -----------------------------------------------------------------------------
-- SELECT id, emp_id, name, work_mode, allow_multiple_sessions
-- FROM employees
-- WHERE is_active = TRUE
--   AND (name LIKE '%Krishna%' OR name LIKE '%Ganesh%' OR name LIKE '%Venkat%'
--     OR name LIKE '%Sasi%'    OR name LIKE '%Karthik%' OR name LIKE '%Madhan%')
-- ORDER BY name;

-- -----------------------------------------------------------------------------
-- STEP 1 — Fill in everything here. Nothing is written until STEP 1b passes.
--
-- radius_meters is the geofence. Clock-in is always allowed within at least
-- 200 m (MIN_LOGIN_RADIUS_M in the clock-in route), so anything smaller has no
-- practical effect; 300–500 m suits a transport yard.
-- -----------------------------------------------------------------------------
-- Peapully — supplied 2026-08-06 as 15°15'17.6"N 77°45'17.2"E (Krishna Mohan).
-- Sits 129 m from his live-tracking fix of 15.256049, 77.754821, which
-- corroborates the site.
SET @peapully_lat  = 15.2548889;
SET @peapully_lng  = 77.7547778;
SET @peapully_rad  = 300;

-- Kodad — supplied 2026-08-06 as 16°57'17.8"N 80°02'14.8"E (Ganesh).
SET @kodad_lat     = 16.9549444;
SET @kodad_lng     = 80.0374444;
SET @kodad_rad     = 300;

-- Hosur — serves Sasi, Karthik and Madhan.
SET @hosur_lat     = 0.0;         -- TODO: fill in (DD°MM'SS.S"N converts as D + M/60 + S/3600)
SET @hosur_lng     = 0.0;         -- TODO: fill in
SET @hosur_rad     = 300;

-- Replace every 'RACEnnn' with the emp_id from the STEP 0 lookup. Employees are
-- matched by emp_id, NOT by name, because names repeat in this database.
SET @emp_krishna    = 'RACE024';  -- Krishnana Mohan — only one match in both screenshots
-- CAUTION: "Ganesh" is ambiguous. At least two employees carry the name:
--   RACE018  Shankar ganesh              (seen in Live Tracking)
--   RACE020  KADALI SRIDATTA GANESH BABU (seen in the attendance report)
-- Pick the right one deliberately — assigning the wrong person to Kodad would
-- geofence them out of clocking in at their real site.
SET @emp_ganesh     = 'RACEnnn';  -- Ganesh           -- TODO: RACE018 or RACE020?
SET @emp_venkatasai = 'RACEnnn';  -- Venkatasai       -- TODO: fill in
SET @emp_sasi       = 'RACEnnn';  -- Sasi             -- TODO: fill in
SET @emp_karthik    = 'RACEnnn';  -- Karthik          -- TODO: fill in
SET @emp_madhan     = 'RACEnnn';  -- Madhan           -- TODO: fill in

-- -----------------------------------------------------------------------------
-- STEP 1b — Guard. A 0,0 geofence sits in the Atlantic and would lock every
-- on-site employee out of clocking in, so refuse to write anything while a
-- placeholder remains. NULLIF turns a placeholder into NULL, and NULL into a
-- NOT NULL column is a hard error under MySQL's default strict mode — the
-- message names the exact field still missing, e.g.
--   ERROR 1048: Column 'kodad_lat' cannot be null
-- -----------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS fill_these_in_before_running;
CREATE TEMPORARY TABLE fill_these_in_before_running (
  peapully_lat DECIMAL(10,7) NOT NULL,
  peapully_lng DECIMAL(10,7) NOT NULL,
  kodad_lat    DECIMAL(10,7) NOT NULL,
  kodad_lng    DECIMAL(10,7) NOT NULL,
  hosur_lat    DECIMAL(10,7) NOT NULL,
  hosur_lng    DECIMAL(10,7) NOT NULL,
  emp_krishna    VARCHAR(20) NOT NULL,
  emp_ganesh     VARCHAR(20) NOT NULL,
  emp_venkatasai VARCHAR(20) NOT NULL,
  emp_sasi       VARCHAR(20) NOT NULL,
  emp_karthik    VARCHAR(20) NOT NULL,
  emp_madhan     VARCHAR(20) NOT NULL
);
INSERT INTO fill_these_in_before_running VALUES (
  NULLIF(@peapully_lat, 0.0), NULLIF(@peapully_lng, 0.0),
  NULLIF(@kodad_lat,    0.0), NULLIF(@kodad_lng,    0.0),
  NULLIF(@hosur_lat,    0.0), NULLIF(@hosur_lng,    0.0),
  NULLIF(@emp_krishna,    'RACEnnn'), NULLIF(@emp_ganesh,  'RACEnnn'),
  NULLIF(@emp_venkatasai, 'RACEnnn'), NULLIF(@emp_sasi,    'RACEnnn'),
  NULLIF(@emp_karthik,    'RACEnnn'), NULLIF(@emp_madhan,  'RACEnnn')
);
DROP TEMPORARY TABLE fill_these_in_before_running;

-- -----------------------------------------------------------------------------
-- STEP 2 — The three work sites.
-- -----------------------------------------------------------------------------
INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
SELECT * FROM (
  SELECT 'Arunachala Transport, Peapully, Kurnool' AS name,
         'Peapully, Kurnool District, Andhra Pradesh' AS address,
         @peapully_lat AS latitude, @peapully_lng AS longitude,
         @peapully_rad AS radius_meters, TRUE AS is_active
  UNION ALL SELECT 'Arunachala Transport, Kodad', 'Kodad, Suryapet District, Telangana',
         @kodad_lat, @kodad_lng, @kodad_rad, TRUE
  UNION ALL SELECT 'Arunachala Transport, Hosur', 'Hosur, Krishnagiri District, Tamil Nadu',
         @hosur_lat, @hosur_lng, @hosur_rad, TRUE
) AS new_sites
WHERE NOT EXISTS (
  SELECT 1 FROM locations l WHERE l.name = new_sites.name
);

-- Keep coordinates current if the rows already existed from an earlier run.
UPDATE locations SET latitude = @peapully_lat, longitude = @peapully_lng, radius_meters = @peapully_rad, is_active = TRUE
  WHERE name = 'Arunachala Transport, Peapully, Kurnool';
UPDATE locations SET latitude = @kodad_lat, longitude = @kodad_lng, radius_meters = @kodad_rad, is_active = TRUE
  WHERE name = 'Arunachala Transport, Kodad';
UPDATE locations SET latitude = @hosur_lat, longitude = @hosur_lng, radius_meters = @hosur_rad, is_active = TRUE
  WHERE name = 'Arunachala Transport, Hosur';

SET @loc_peapully = (SELECT id FROM locations WHERE name = 'Arunachala Transport, Peapully, Kurnool' LIMIT 1);
SET @loc_kodad    = (SELECT id FROM locations WHERE name = 'Arunachala Transport, Kodad' LIMIT 1);
SET @loc_hosur    = (SELECT id FROM locations WHERE name = 'Arunachala Transport, Hosur' LIMIT 1);

-- -----------------------------------------------------------------------------
-- STEP 3 — Point each employee's ACTIVE schedule at their site.
-- An employee with no active schedule is reported in STEP 4 and needs a shift
-- assigned from the Schedules page first — this script does not invent one.
--
-- Only the schedule row in force today is updated (effective_from <= today and
-- not yet expired), so historical assignments stay intact for old reports.
-- -----------------------------------------------------------------------------
UPDATE employee_schedules es
JOIN employees e ON e.id = es.employee_id
SET es.location_id = CASE e.emp_id
      WHEN @emp_krishna    THEN @loc_peapully
      WHEN @emp_ganesh     THEN @loc_kodad
      WHEN @emp_venkatasai THEN @loc_kodad
      WHEN @emp_sasi       THEN @loc_hosur
      WHEN @emp_karthik    THEN @loc_hosur
      WHEN @emp_madhan     THEN @loc_hosur
    END,
    -- Geofencing ON so attendance is tied to the yard. Set to FALSE instead if
    -- any of these are field staff who clock in away from the site.
    es.geofencing_enabled = TRUE
WHERE e.emp_id IN (@emp_krishna, @emp_ganesh, @emp_venkatasai, @emp_sasi, @emp_karthik, @emp_madhan)
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE());

-- -----------------------------------------------------------------------------
-- STEP 4 — Verify. Every one of the six should show their site name.
-- A NULL location (or a missing row) means that employee has no active
-- schedule — fix that in the Schedules page, then re-run STEP 2.
-- -----------------------------------------------------------------------------
SELECT e.emp_id, e.name, l.name AS attendance_location,
       es.geofencing_enabled, l.latitude, l.longitude, l.radius_meters
FROM employees e
LEFT JOIN employee_schedules es
  ON es.employee_id = e.id
  AND es.effective_from <= CURDATE()
  AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())
LEFT JOIN locations l ON l.id = es.location_id
WHERE e.emp_id IN (@emp_krishna, @emp_ganesh, @emp_venkatasai, @emp_sasi, @emp_karthik, @emp_madhan)
ORDER BY e.name;
