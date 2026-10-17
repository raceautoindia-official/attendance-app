-- ---------------------------------------------------------------------------
-- 2026-10-12_company_locations.sql
--
-- A work site belongs to a company, and one of them is the registered office.
--
-- THE PROBLEM THIS FIXES
-- ----------------------
-- `locations` already holds a name, an address, a city, a state, a country and
-- a pair of coordinates for every site this company works from - six of them.
-- `companies` then asked somebody to type an address again, in its own
-- columns, with nothing connecting the two. So the registered address and the
-- site it is actually at could disagree, and nobody would ever find out.
--
-- Two links, both nullable, both additive:
--
--   locations.company_id          - which company this site belongs to
--   companies.registered_location_id - which site is the registered office
--
-- Nullable on purpose. Six locations exist today and no company does, so
-- anything mandatory here would break the attendance geofence - which reads
-- these rows on every clock-in - in exchange for tidiness.
--
-- The statutory address columns on `companies` STAY. A registered address can
-- legitimately differ from the site, and a filing uses what was filed. What
-- changes is that it no longer has to be typed from memory: the Company screen
-- can copy it from the chosen site.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'company_id');
SET @sql := IF(@have = 0,
  'ALTER TABLE locations
     ADD COLUMN company_id INT NULL COMMENT ''Which company this site belongs to''
       AFTER name,
     ADD KEY idx_location_company (company_id),
     ADD CONSTRAINT fk_location_company FOREIGN KEY (company_id)
       REFERENCES companies(id) ON DELETE SET NULL',
  'SELECT ''locations.company_id already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ON DELETE SET NULL in both directions, deliberately. Deleting a company
-- must not cascade into the locations that attendance is measured against, and
-- removing a site must not take the company's registered address with it.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies'
    AND COLUMN_NAME = 'registered_location_id');
SET @sql := IF(@have = 0,
  'ALTER TABLE companies
     ADD COLUMN registered_location_id INT NULL
       COMMENT ''The site that is the registered office''
       AFTER logo_url,
     ADD KEY idx_company_registered_location (registered_location_id),
     ADD CONSTRAINT fk_company_registered_location FOREIGN KEY (registered_location_id)
       REFERENCES locations(id) ON DELETE SET NULL',
  'SELECT ''companies.registered_location_id already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
