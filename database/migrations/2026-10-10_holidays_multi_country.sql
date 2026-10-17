-- ---------------------------------------------------------------------------
-- 2026-10-10_holidays_multi_country.sql
--
-- Make the holiday calendar able to hold more than one country.
--
-- TWO CHANGES, AND THE SECOND IS THE IMPORTANT ONE.
--
-- 1. `source` gains 'library'. Holidays computed by date-holidays are a third
--    kind: not hand-entered, and not from the bundled India files either.
--    Telling them apart matters because they have different coverage - see
--    below - and an administrator deciding whether to trust a date needs to
--    know where it came from.
--
-- 2. The unique key gains `country_code`. It was
--    (holiday_date, name, state_key), which is fine for one country and wrong
--    the moment there are two: 'Christmas Day' on 2026-12-25 with no state is
--    the SAME KEY in India and the United Kingdom, so importing the second
--    country would silently drop it as a duplicate of the first.
--
-- ON COVERAGE, STATED PLAINLY. date-holidays returns 7 public holidays for
-- Tamil Nadu in 2026; the bundled file has 24, including Pongal and Deepavali.
-- The library is how any of 207 countries becomes possible at all, but for
-- India it is thinner than what is already here. Both therefore coexist as
-- candidates, and nothing is observed until somebody says so.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

-- 1. A third source.
SET @has_library := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
     AND COLUMN_NAME = 'source' AND COLUMN_TYPE LIKE '%library%');
SET @sql := IF(@has_library = 0,
  'ALTER TABLE holiday_calendar MODIFY COLUMN source ENUM(''bundled'',''manual'',''library'') NOT NULL DEFAULT ''bundled''',
  'SELECT ''holiday_calendar.source already allows library''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. A region column, so a state or province from the library has somewhere
--    to live that is not the India-specific state_code.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar' AND COLUMN_NAME = 'region_code');
SET @sql := IF(@have = 0,
  'ALTER TABLE holiday_calendar ADD COLUMN region_code VARCHAR(10) NULL AFTER country_code',
  'SELECT ''holiday_calendar.region_code already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. The unique key, widened to include the country.
--
--    Dropped and recreated rather than added alongside: leaving the old,
--    narrower key in place would keep rejecting the very rows this change
--    exists to allow.
SET @have_old := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
    AND INDEX_NAME = 'uq_holiday_calendar');
SET @have_new := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
    AND INDEX_NAME = 'uq_holiday_country');

SET @sql := IF(@have_old > 0 AND @have_new = 0,
  'ALTER TABLE holiday_calendar DROP INDEX uq_holiday_calendar',
  'SELECT ''old holiday unique key already removed''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have_new := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar'
    AND INDEX_NAME = 'uq_holiday_country');
SET @sql := IF(@have_new = 0,
  'ALTER TABLE holiday_calendar ADD UNIQUE KEY uq_holiday_country (country_code, holiday_date, name, state_key)',
  'SELECT ''country-aware holiday unique key already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 4. Country and city on a work location, so a site can say which calendar
--    applies to it. locations.country_code arrived with the org migration;
--    this only backfills anything left empty.
UPDATE locations SET country_code = 'IN' WHERE country_code IS NULL OR country_code = '';

-- 5. Which countries this company actually operates in.
--
--    Without this the picker offers all 207 every time, and the two that
--    matter are no easier to find than the rest.
CREATE TABLE IF NOT EXISTS holiday_countries (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  country_code CHAR(2)      NOT NULL,
  country_name VARCHAR(120) NOT NULL,
  region_code  VARCHAR(10)  NULL,
  region_name  VARCHAR(120) NULL,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  added_by     INT          NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL != NULL in a MySQL unique key, so (GB, NULL) twice is two distinct
  -- rows and 'add United Kingdom' would duplicate on every click. The
  -- generated column collapses NULL to a real value, which is the same trick
  -- holiday_calendar.state_key already uses.
  region_key   VARCHAR(10) GENERATED ALWAYS AS (COALESCE(region_code, '-')) VIRTUAL,
  UNIQUE KEY uk_holiday_country_region (country_code, region_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- India is where this company already is, so it starts selected.
INSERT INTO holiday_countries (country_code, country_name, region_code, region_name)
SELECT * FROM (SELECT 'IN' AS cc, 'India' AS cn, 'TN' AS rc, 'Tamil Nadu' AS rn) AS t
WHERE NOT EXISTS (SELECT 1 FROM holiday_countries WHERE country_code = 'IN' AND region_code = 'TN');

-- Repair a holiday_countries created before region_key existed. Without it,
-- adding the same country twice silently produced two rows.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_countries' AND COLUMN_NAME = 'region_key');
SET @sql := IF(@have = 0,
  'ALTER TABLE holiday_countries DROP INDEX uk_holiday_country_region,
     ADD COLUMN region_key VARCHAR(10) GENERATED ALWAYS AS (COALESCE(region_code, ''-'')) VIRTUAL,
     ADD UNIQUE KEY uk_holiday_country_region (country_code, region_key)',
  'SELECT ''holiday_countries.region_key already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
