-- ---------------------------------------------------------------------------
-- 2026-10-10_rbac.sql
--
-- Roles, permissions, and the SCOPE each grant carries.
--
-- A permission on its own is not enough. "A manager may view attendance" has
-- to mean THEIR team's attendance, so every grant answers two questions: what
-- may they do, and over whom. Without the second half, the first half is just
-- a switch that turns the whole company on.
--
-- SHIPS INERT. `employees.role` keeps working exactly as it does today, and
-- nothing consults these tables until an administrator grants somebody a role.
-- Same discipline as the policy system: an employee with no role row behaves
-- precisely as before, so applying this migration changes nobody's access.
--
-- `employees.role` is NOT replaced or dropped. The mobile app reads it, and
-- the proxy gates pages on it. This sits alongside and refines.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. What can be done
--
-- Named by the action, not by the page. 'attendance.view' survives the page
-- being renamed, split or merged; 'can_see_attendance_page' does not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  perm_key    VARCHAR(60)  NOT NULL,
  label       VARCHAR(120) NOT NULL,
  description VARCHAR(400) NULL,
  category    VARCHAR(40)  NOT NULL DEFAULT 'general',
  -- Scoping is meaningless for some things. Managing holidays is company-wide
  -- or it is nothing, and offering a 'team' scope on it would invite somebody
  -- to configure a state that cannot be honoured.
  scopable    BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uk_permission_key (perm_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Named sets of grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(40)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(400) NULL,
  -- A system role may be granted and revoked but not renamed or deleted: the
  -- fallback mapping from employees.role points at these by code, and losing
  -- one would silently change what an existing user can do.
  is_system   BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_role_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. The grant, and how far it reaches
--
--   self        only their own records
--   team        the team they lead
--   department  their department and everything below it in the tree
--   all         everybody
--
-- 'department' is why the department tree exists: resolving it walks downward
-- from their node. It is also the single piece of logic most likely to leak
-- data if it is wrong, which is why it has its own suite before any page
-- relies on it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  role_id       INT NOT NULL,
  permission_id INT NOT NULL,
  scope         ENUM('self','team','department','all') NOT NULL DEFAULT 'self',
  UNIQUE KEY uk_role_permission (role_id, permission_id),
  KEY idx_rp_permission (permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id)
    REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Who holds which role
--
-- Several roles per person is allowed, and the WIDEST scope wins when two
-- roles grant the same permission. The alternative - narrowest wins - means
-- adding a role can take access away, which nobody expects from the word
-- "grant".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  role_id     INT NOT NULL,
  granted_by  INT NULL,
  granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes       VARCHAR(400) NULL,
  UNIQUE KEY uk_employee_role (employee_id, role_id),
  KEY idx_er_role (role_id),
  CONSTRAINT fk_er_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_er_role FOREIGN KEY (role_id)
    REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. The permission catalogue
-- ---------------------------------------------------------------------------
INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'attendance.view' AS k, 'View attendance' AS l,
  'See clock-ins, clock-outs and worked hours.' AS d, 'attendance' AS c, TRUE AS s, 10 AS o) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'attendance.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'attendance.edit', 'Correct attendance',
  'Change a recorded day. Always written to the audit log.', 'attendance', TRUE, 20) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'attendance.edit');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'employee.view', 'View employees',
  'See the people list and each profile.', 'people', TRUE, 30) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'employee.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'employee.manage', 'Add and edit employees',
  'Create, edit and deactivate people.', 'people', TRUE, 40) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'employee.manage');

-- Deliberately its own permission. Most managers need the person, not their
-- Aadhaar number, and bundling identity documents into "view employee" is how
-- a whole company ends up able to read them.
INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'employee.view_identity', 'View identity and bank details',
  'PAN, Aadhaar, bank account. Separate from viewing an employee on purpose.',
  'people', TRUE, 50) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'employee.view_identity');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'leave.view', 'View leave', 'See leave records and balances.', 'time', TRUE, 60) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'leave.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'leave.approve', 'Approve leave', 'Grant or refuse leave requests.', 'time', TRUE, 70) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'leave.approve');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'permission.approve', 'Approve permission requests',
  'Decide short time-off requests.', 'time', TRUE, 80) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'permission.approve');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'reports.view', 'View reports', 'Attendance and hours reporting.', 'insight', TRUE, 90) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'reports.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'reports.export', 'Export reports',
  'Download CSV, Excel and PDF.', 'insight', TRUE, 100) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'reports.export');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'payroll.export', 'Export the payroll pack',
  'The monthly pack a pay dispute is settled against.', 'insight', TRUE, 110) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'payroll.export');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'performance.view', 'View performance scores',
  'Scores and rankings.', 'insight', TRUE, 120) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'performance.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'documents.view', 'View documents',
  'Employee documents on file.', 'people', TRUE, 130) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'documents.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'documents.manage', 'Upload and remove documents',
  'Add or delete employee documents.', 'people', TRUE, 140) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'documents.manage');

-- Company-wide by nature: these configure the system, not a set of people.
INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'org.manage', 'Manage the organisation',
  'Departments, teams, grades and company profiles.', 'setup', FALSE, 150) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'org.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'policy.manage', 'Manage policies',
  'Create and assign policies.', 'setup', FALSE, 160) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'policy.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'schedule.manage', 'Manage shifts and schedules',
  'Shifts, rosters and who works them.', 'setup', FALSE, 170) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'schedule.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'holiday.manage', 'Manage the holiday calendar',
  'Company-wide or nothing.', 'setup', FALSE, 180) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'holiday.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'location.manage', 'Manage work locations',
  'Sites and geofences.', 'setup', FALSE, 190) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'location.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'roles.manage', 'Manage roles and access',
  'Who may do what. Grant with care.', 'setup', FALSE, 200) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'roles.manage');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'audit.view', 'View the audit log',
  'What was changed, by whom.', 'setup', FALSE, 210) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'audit.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'tracking.view', 'View live tracking',
  'Where somebody is during their shift.', 'attendance', TRUE, 220) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'tracking.view');

-- ---------------------------------------------------------------------------
-- 6. System roles, mirroring what employees.role already means
--
-- Created so the fallback has something to point at and so an administrator
-- can see, rather than infer, what today's three roles actually permit.
-- ---------------------------------------------------------------------------
INSERT INTO roles (code, name, description, is_system)
SELECT * FROM (SELECT 'super_admin' AS c, 'Super Admin' AS n,
  'Everything, everywhere. Keeps a hard-coded bypass so access control cannot lock out its own administrator.' AS d,
  TRUE AS s) AS t
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'super_admin');

INSERT INTO roles (code, name, description, is_system)
SELECT * FROM (SELECT 'manager' AS c, 'Manager' AS n,
  'Reads and approves for their own department and everything below it.' AS d, TRUE AS s) AS t
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'manager');

INSERT INTO roles (code, name, description, is_system)
SELECT * FROM (SELECT 'employee' AS c, 'Employee' AS n,
  'Their own records only.' AS d, TRUE AS s) AS t
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'employee');

-- Manager: department-wide read and approval, no setup, no identity numbers.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'department'
  FROM roles r JOIN permissions p
 WHERE r.code = 'manager'
   AND p.perm_key IN ('attendance.view','employee.view','leave.view','leave.approve',
                      'permission.approve','reports.view','reports.export',
                      'performance.view','documents.view','tracking.view')
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = p.id);

-- Employee: themselves, and nothing else.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'self'
  FROM roles r JOIN permissions p
 WHERE r.code = 'employee'
   AND p.perm_key IN ('attendance.view','leave.view')
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = p.id);

-- Super admin: every permission at the widest scope. Written out rather than
-- special-cased alone, so the Roles page can SHOW what it means - but the code
-- also keeps a hard bypass, because a permission system that can lock out its
-- own administrator will eventually do so.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
  FROM roles r JOIN permissions p
 WHERE r.code = 'super_admin'
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = p.id);
