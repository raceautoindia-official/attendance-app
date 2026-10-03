-- =============================================================================
-- 2026-10-03 — Holiday calendar: candidate holidays + per-location observance
--
-- Run against the attendance database, e.g.:
--   mysql -u <user> -p <database> < database/migrations/2026-10-03_holiday_calendar.sql
--
-- Check first (reports APPLIED / MISSING / PARTIAL, changes nothing):
--   mysql -u <user> -p <database> < database/migrations/check-status.sql
--
-- DESIGN — "propose, don't apply"
-- ------------------------------------------------------------------------
-- `holiday_calendar` is a CANDIDATE list. A row in it has NO effect on
-- attendance. An admin decides per location whether the company observes it
-- (`holiday_observances`), and only then is a `leave_records` row written
-- through the existing company-holiday mechanism.
--
-- This matters because creating a holiday runs
-- `UPDATE attendance SET status='holiday'` across employees. Anything that
-- writes to that path automatically — an API sync, say — can corrupt a day of
-- attendance, and therefore payroll, for everyone. A human stays in the loop.
--
-- `leave_records.location_id` is the one change to an existing table, and it is
-- additive and backward compatible: every existing row is NULL, which means
-- "all locations" — exactly what those rows mean today.
--
-- The ALTERs are not idempotent — run once. The CREATE TABLEs are safe to re-run.
-- =============================================================================

-- 1. Locations gain a state code so regional holidays can be matched to a site.
--    NULL means "not specified" — such a site sees national holidays only.
ALTER TABLE locations
  ADD COLUMN state_code VARCHAR(5) NULL AFTER address;

-- 2. Scope a leave_records row to one location.
--    NULL = all locations (including employees with no location assigned).
--    Every pre-existing row is NULL, so current behaviour is unchanged.
ALTER TABLE leave_records
  ADD COLUMN location_id INT NULL AFTER employee_id,
  ADD INDEX idx_leave_records_location (location_id),
  ADD CONSTRAINT fk_leave_records_location
    FOREIGN KEY (location_id) REFERENCES locations (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- 3. Candidate holidays. Populated from the bundled dataset in
--    data/holidays/, or added by hand. Affects nothing on its own.
CREATE TABLE IF NOT EXISTS holiday_calendar (
  id            INT           NOT NULL AUTO_INCREMENT,
  year          SMALLINT      NOT NULL,
  holiday_date  DATE          NOT NULL,
  name          VARCHAR(150)  NOT NULL,
  -- national: observed across India. regional: specific states (see state_code).
  -- company: added by this company, not from any published list.
  holiday_type  ENUM('national','regional','company') NOT NULL DEFAULT 'national',
  -- NULL = applies nationally; otherwise an ISO 3166-2:IN subdivision suffix
  -- such as 'TN', 'KL', 'MH', matched against locations.state_code.
  state_code    VARCHAR(5)    NULL,
  -- TRUE for festivals on a lunar or otherwise variable calendar (Diwali, Eid,
  -- Holi …). The bundled dataset cannot guarantee these dates, so the UI must
  -- make the admin confirm the date before the holiday can be observed.
  needs_verification BOOLEAN  NOT NULL DEFAULT FALSE,
  source        ENUM('bundled','manual') NOT NULL DEFAULT 'bundled',
  notes         VARCHAR(500)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- MySQL treats NULLs in a UNIQUE index as distinct, so a key on
  -- (holiday_date, name, state_code) would NOT dedupe national holidays, where
  -- state_code IS NULL — a re-import would insert them all again. Folding NULL
  -- to '-' in a stored generated column makes the key actually unique while
  -- keeping NULL as the natural "applies nationally" value in state_code.
  state_key VARCHAR(5) GENERATED ALWAYS AS (COALESCE(state_code, '-')) VIRTUAL,

  PRIMARY KEY (id),
  -- Makes re-importing the bundled dataset idempotent.
  UNIQUE KEY uq_holiday_calendar (holiday_date, name, state_key),
  INDEX idx_holiday_calendar_year (year),
  INDEX idx_holiday_calendar_date (holiday_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. The admin's decision, per location.
--    An explicit is_observed = FALSE records a deliberate "we work that day",
--    which is different from "nobody has decided yet" (no row at all).
CREATE TABLE IF NOT EXISTS holiday_observances (
  id           INT      NOT NULL AUTO_INCREMENT,
  holiday_id   INT      NOT NULL,
  -- NULL = every location, including employees with no location assigned.
  location_id  INT      NULL,
  is_observed  BOOLEAN  NOT NULL DEFAULT FALSE,
  -- The leave_records row this decision produced, so un-observing can reverse
  -- exactly what was applied rather than guessing.
  leave_record_id INT   NULL,
  decided_by   INT      NULL,
  decided_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Same NULL trap as holiday_calendar: a UNIQUE on (holiday_id, location_id)
  -- does NOT dedupe the "all locations" rows, where location_id IS NULL, so
  -- ON DUPLICATE KEY UPDATE would never fire for them and the decision would be
  -- recorded repeatedly. Fold NULL to 0 in a stored generated column.
  location_key INT GENERATED ALWAYS AS (COALESCE(location_id, 0)) VIRTUAL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_holiday_obs_nullsafe (holiday_id, location_key),
  INDEX idx_holiday_observances_location (location_id),

  CONSTRAINT fk_holiday_observances_holiday
    FOREIGN KEY (holiday_id) REFERENCES holiday_calendar (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_holiday_observances_location
    FOREIGN KEY (location_id) REFERENCES locations (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_holiday_observances_decided_by
    FOREIGN KEY (decided_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
