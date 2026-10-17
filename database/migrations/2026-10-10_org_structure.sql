-- ---------------------------------------------------------------------------
-- 2026-10-10_org_structure.sql
--
-- Company profile, a department TREE, job grades, teams, and dated assignments.
--
-- Additive only. The mobile app shares this database, so nothing is renamed,
-- nothing changes type, and `employees.department` -- the free-text column this
-- replaces -- is left exactly where it is. Nothing reads it after this, but
-- deleting a column the phone might still select is how a deployment takes the
-- phone down.
--
-- GRADES AND DEPARTMENTS ARE SEPARATE ON PURPOSE. A grade travels with the
-- person when they move department; a department keeps its shape when somebody
-- is promoted. Folding one into the other makes a promotion look like a
-- transfer, and makes "who is in Operations" unanswerable the moment anybody
-- is promoted within it.
--
-- Guarded throughout: every statement checks INFORMATION_SCHEMA first, so this
-- is safe to re-run and safe to run against a database where somebody has
-- already applied half of it by hand.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The company
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  legal_name      VARCHAR(200) NOT NULL,
  trading_name    VARCHAR(200) NULL,
  registration_no VARCHAR(60)  NULL,
  pan             VARCHAR(20)  NULL,
  tan             VARCHAR(20)  NULL,
  gstin           VARCHAR(30)  NULL,
  pf_code         VARCHAR(40)  NULL,
  esi_code        VARCHAR(40)  NULL,
  address_line1   VARCHAR(200) NULL,
  address_line2   VARCHAR(200) NULL,
  city            VARCHAR(100) NULL,
  state_code      VARCHAR(10)  NULL,
  country_code    CHAR(2)      NOT NULL DEFAULT 'IN',
  postal_code     VARCHAR(20)  NULL,
  phone           VARCHAR(40)  NULL,
  email           VARCHAR(160) NULL,
  website         VARCHAR(200) NULL,
  logo_url        VARCHAR(500) NULL,
  -- April in India. Stored so reports can offer "this financial year" without
  -- assuming a jurisdiction.
  fy_start_month  TINYINT      NOT NULL DEFAULT 4,
  timezone        VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Departments -- a tree
--
-- `parent_id` makes depth arbitrary: a top-level department is one with no
-- parent, and "L2" is simply a department whose parent is an L1. `depth` is
-- stored because every list query needs it for indentation and recomputing it
-- per row means a recursive query per render; it is maintained by the
-- application, which is the only thing that moves a node.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  company_id       INT          NULL,
  parent_id        INT          NULL,
  name             VARCHAR(120) NOT NULL,
  code             VARCHAR(40)  NOT NULL,
  description      VARCHAR(500) NULL,
  head_employee_id INT          NULL,
  depth            TINYINT      NOT NULL DEFAULT 0,
  sort_order       INT          NOT NULL DEFAULT 0,
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_department_code (code),
  KEY idx_department_parent (parent_id),
  CONSTRAINT fk_department_parent FOREIGN KEY (parent_id)
    REFERENCES departments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_department_head FOREIGN KEY (head_employee_id)
    REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Grades -- seniority, carried by the person
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grades (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(20)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  -- Lower sorts first. A number rather than the code, because "L10" sorts
  -- before "L2" as a string and a seniority list that does that is wrong.
  rank_order  INT          NOT NULL DEFAULT 0,
  description VARCHAR(500) NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_grade_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Teams -- inside one department
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  department_id    INT          NOT NULL,
  name             VARCHAR(120) NOT NULL,
  code             VARCHAR(40)  NOT NULL,
  lead_employee_id INT          NULL,
  description      VARCHAR(500) NULL,
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_team_code (code),
  KEY idx_team_department (department_id),
  CONSTRAINT fk_team_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_team_lead FOREIGN KEY (lead_employee_id)
    REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Who is where, and since when
--
-- Dated, exactly like employee_schedules and employee_policies, for the same
-- reason: somebody who moves department in March must have January still
-- reported under the old one. Without the dates a reorganisation silently
-- rewrites every past report.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_org_assignments (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  employee_id             INT  NOT NULL,
  department_id           INT  NULL,
  team_id                 INT  NULL,
  grade_id                INT  NULL,
  reports_to_employee_id  INT  NULL,
  designation             VARCHAR(120) NULL,
  effective_from          DATE NOT NULL,
  effective_to            DATE NULL,
  assigned_by             INT  NULL,
  notes                   VARCHAR(500) NULL,
  created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_org_employee_dates (employee_id, effective_from, effective_to),
  KEY idx_org_department (department_id),
  KEY idx_org_team (team_id),
  KEY idx_org_reports_to (reports_to_employee_id),
  CONSTRAINT fk_org_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_org_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_org_team FOREIGN KEY (team_id)
    REFERENCES teams (id) ON DELETE SET NULL,
  CONSTRAINT fk_org_grade FOREIGN KEY (grade_id)
    REFERENCES grades (id) ON DELETE SET NULL,
  CONSTRAINT fk_org_reports_to FOREIGN KEY (reports_to_employee_id)
    REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 6. Seed the departments that are actually salvageable
--
-- The old free-text column holds five values across sixteen people, and two of
-- them are not departments at all: 'ADMIN001' is an employee id and
-- '7305408577' is a phone number. Only the real ones are created here.
--
-- Nobody is assigned automatically. Mapping a person into a department on the
-- strength of a corrupted free-text field would bury the problem; leaving them
-- unassigned makes the Departments page show exactly who still needs placing,
-- which is the only way it gets fixed.
-- ---------------------------------------------------------------------------
INSERT INTO departments (name, code, depth, sort_order)
SELECT * FROM (SELECT 'Operations' AS name, 'OPS' AS code, 0 AS depth, 10 AS sort_order) AS t
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'OPS');

INSERT INTO departments (name, code, depth, sort_order)
SELECT * FROM (SELECT 'Sales' AS name, 'SALES' AS code, 0 AS depth, 20 AS sort_order) AS t
WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'SALES');

INSERT INTO departments (name, code, parent_id, depth, sort_order)
SELECT 'Wash Plant', 'WASH', d.id, 1, 10
  FROM departments d
 WHERE d.code = 'OPS'
   AND NOT EXISTS (SELECT 1 FROM departments WHERE code = 'WASH');

-- ---------------------------------------------------------------------------
-- 7. A starting ladder of grades
--
-- rank_order leaves gaps so a grade can be inserted between two existing ones
-- without renumbering the rest.
-- ---------------------------------------------------------------------------
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L1' AS code, 'L1 - Trainee / Entry' AS name, 10 AS rank_order) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L1');
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L2', 'L2 - Executive', 20) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L2');
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L3', 'L3 - Senior Executive', 30) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L3');
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L4', 'L4 - Lead', 40) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L4');
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L5', 'L5 - Manager', 50) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L5');
INSERT INTO grades (code, name, rank_order)
SELECT * FROM (SELECT 'L6', 'L6 - Head of Department', 60) AS t
WHERE NOT EXISTS (SELECT 1 FROM grades WHERE code = 'L6');

-- ---------------------------------------------------------------------------
-- 8. Country and city, so holidays and sites can be filtered by them
--
-- `locations` already carries state_code but no country, so "filter by country
-- and city" has nothing to filter on today.
-- ---------------------------------------------------------------------------
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'country_code');
SET @sql := IF(@have = 0,
  'ALTER TABLE locations ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT ''IN'' AFTER state_code',
  'SELECT ''locations.country_code already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'locations' AND COLUMN_NAME = 'city');
SET @sql := IF(@have = 0,
  'ALTER TABLE locations ADD COLUMN city VARCHAR(100) NULL AFTER address',
  'SELECT ''locations.city already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holiday_calendar' AND COLUMN_NAME = 'country_code');
SET @sql := IF(@have = 0,
  'ALTER TABLE holiday_calendar ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT ''IN'' AFTER year',
  'SELECT ''holiday_calendar.country_code already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Existing rows are all Indian, which the DEFAULT already gave them. Stated
-- rather than assumed, so a later reader does not have to work it out.
UPDATE holiday_calendar SET country_code = 'IN' WHERE country_code IS NULL OR country_code = '';

-- ---------------------------------------------------------------------------
-- 9. Joining date -- onboarding cannot schedule anything without it
-- ---------------------------------------------------------------------------
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'joined_on');
SET @sql := IF(@have = 0,
  'ALTER TABLE employees ADD COLUMN joined_on DATE NULL AFTER department',
  'SELECT ''employees.joined_on already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;
