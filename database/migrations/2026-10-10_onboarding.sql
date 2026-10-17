-- ---------------------------------------------------------------------------
-- 2026-10-10_onboarding.sql
--
-- Joining and leaving, as checklists that somebody is accountable for.
--
-- ONE SET OF TABLES FOR BOTH DIRECTIONS. Offboarding is the same shape as
-- onboarding - a dated list of tasks with owners - and the only honest
-- difference is which way the person is travelling. Two parallel sets of
-- tables would be the same code twice, and the second copy is always the one
-- that rots.
--
-- The cost of having no offboarding is specific: an ex-employee who can still
-- sign in, and a laptop nobody asked for. That is why it ships now rather than
-- being retrofitted.
--
-- Additive only. Nothing existing is renamed or re-typed; the mobile app
-- shares this database.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. A named checklist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_templates (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  direction   ENUM('onboarding','offboarding') NOT NULL DEFAULT 'onboarding',
  description VARCHAR(400) NULL,
  -- Used when nobody picks one. Exactly one default per direction is the
  -- intent; the application enforces it, because a partial unique index on a
  -- boolean is not portable.
  is_default  BOOLEAN   NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_template_direction (direction, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. What the checklist contains
--
-- `due_offset_days` is relative to the joining or leaving date, so one
-- template serves every starter. Negative is allowed and matters: an offer
-- letter signed and a desk prepared belong BEFORE day one, and a template that
-- cannot express that pushes them into day one where they are already late.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onboarding_template_tasks (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  template_id     INT NOT NULL,
  title           VARCHAR(160) NOT NULL,
  description     VARCHAR(500) NULL,
  -- Who is expected to do it. A role, not a person: the person who does this
  -- for the next starter may not be the one who did it for the last.
  owner_role      ENUM('hr','manager','it','employee','finance') NOT NULL DEFAULT 'hr',
  category        VARCHAR(40)  NOT NULL DEFAULT 'general',
  due_offset_days INT          NOT NULL DEFAULT 0,
  -- A blocking task is one where carrying on without it causes real harm:
  -- no signed contract, no statutory enrolment, access not revoked. Marking
  -- everything blocking makes the flag mean nothing.
  is_blocking     BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order      INT          NOT NULL DEFAULT 0,
  CONSTRAINT fk_tpl_task_template FOREIGN KEY (template_id)
    REFERENCES onboarding_templates (id) ON DELETE CASCADE,
  KEY idx_tpl_task_template (template_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. One person's journey through a checklist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_onboarding (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  employee_id  INT NOT NULL,
  template_id  INT NULL,
  direction    ENUM('onboarding','offboarding') NOT NULL DEFAULT 'onboarding',
  -- The date everything is measured from: joining for onboarding, last day
  -- for offboarding.
  anchor_date  DATE NOT NULL,
  status       ENUM('in_progress','completed','cancelled') NOT NULL DEFAULT 'in_progress',
  started_by   INT NULL,
  completed_at TIMESTAMP NULL,
  notes        VARCHAR(500) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_journey_employee (employee_id, direction, status),
  KEY idx_journey_status (status, direction),
  CONSTRAINT fk_journey_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON DELETE CASCADE,
  -- The template may be edited or retired later; a journey already under way
  -- keeps its own copy of the tasks, so it is not disturbed.
  CONSTRAINT fk_journey_template FOREIGN KEY (template_id)
    REFERENCES onboarding_templates (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. The real, dated tasks
--
-- COPIED from the template at the moment a journey starts, not joined to it.
-- Editing a template must not silently rewrite what somebody was asked to do
-- three weeks ago, and a completed checklist has to stay readable as the
-- checklist that was actually completed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_onboarding_tasks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  journey_id    INT NOT NULL,
  title         VARCHAR(160) NOT NULL,
  description   VARCHAR(500) NULL,
  owner_role    ENUM('hr','manager','it','employee','finance') NOT NULL DEFAULT 'hr',
  category      VARCHAR(40)  NOT NULL DEFAULT 'general',
  due_on        DATE NULL,
  is_blocking   BOOLEAN NOT NULL DEFAULT FALSE,
  status        ENUM('pending','done','not_applicable') NOT NULL DEFAULT 'pending',
  completed_at  TIMESTAMP NULL,
  completed_by  INT NULL,
  notes         VARCHAR(500) NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_task_journey FOREIGN KEY (journey_id)
    REFERENCES employee_onboarding (id) ON DELETE CASCADE,
  KEY idx_task_journey (journey_id, sort_order),
  KEY idx_task_due (status, due_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Leaving date, so an offboarding journey has something to anchor to
-- ---------------------------------------------------------------------------
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'last_working_day');
SET @sql := IF(@have = 0,
  'ALTER TABLE employees ADD COLUMN last_working_day DATE NULL AFTER joined_on',
  'SELECT ''employees.last_working_day already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Probation already exists on policies as a NUMBER of months and nothing uses
-- it. A date is what can actually be reminded about; a count of months cannot.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'probation_ends_on');
SET @sql := IF(@have = 0,
  'ALTER TABLE employees ADD COLUMN probation_ends_on DATE NULL AFTER last_working_day',
  'SELECT ''employees.probation_ends_on already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Documents expire. Contracts, visas and certifications lapse, and a document
-- table with no expiry quietly reports somebody as compliant forever.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'expires_on');
SET @sql := IF(@have = 0,
  'ALTER TABLE employee_documents ADD COLUMN expires_on DATE NULL AFTER doc_type',
  'SELECT ''employee_documents.expires_on already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 6. The default joining checklist
--
-- The three that were asked for - ID card, training, attendance app - plus the
-- ones that get forgotten until somebody needs them: statutory enrolment, an
-- emergency contact, and a first clock-in actually seen rather than assumed.
-- ---------------------------------------------------------------------------
INSERT INTO onboarding_templates (name, direction, description, is_default)
SELECT * FROM (SELECT 'Standard joining' AS n, 'onboarding' AS d,
  'The default checklist for a new starter.' AS de, TRUE AS df) AS t
WHERE NOT EXISTS (SELECT 1 FROM onboarding_templates
                   WHERE name = 'Standard joining' AND direction = 'onboarding');

INSERT INTO onboarding_template_tasks
  (template_id, title, description, owner_role, category, due_offset_days, is_blocking, sort_order)
SELECT tpl.id, x.title, x.descr, x.owner, x.cat, x.offs, x.blocking, x.srt
  FROM onboarding_templates tpl
  JOIN (
    SELECT 'Offer letter signed' AS title, 'Signed copy received and filed.' AS descr,
           'hr' AS owner, 'paperwork' AS cat, -7 AS offs, TRUE AS blocking, 10 AS srt
    UNION ALL SELECT 'Identity documents collected', 'Aadhaar, PAN and a government ID.', 'hr', 'paperwork', -3, TRUE, 20
    UNION ALL SELECT 'Bank details captured', 'For salary payment.', 'finance', 'paperwork', -1, TRUE, 30
    UNION ALL SELECT 'Emergency contact recorded', 'Who to call. Easy to skip, impossible to improvise.', 'employee', 'paperwork', 1, FALSE, 40
    UNION ALL SELECT 'Workspace and assets ready', 'Desk, laptop, SIM, keys, protective equipment.', 'it', 'assets', -1, FALSE, 50
    UNION ALL SELECT 'ID card issued', 'Photo taken and card handed over.', 'hr', 'assets', 1, FALSE, 60
    UNION ALL SELECT 'Email and system accounts created', 'Including this app.', 'it', 'access', -1, TRUE, 70
    UNION ALL SELECT 'Attendance app installed', 'Installed on their own phone and signed in.', 'employee', 'access', 1, FALSE, 80
    UNION ALL SELECT 'First clock-in seen', 'Confirmed working, not assumed. The app can be installed and still never used.', 'manager', 'access', 2, FALSE, 90
    UNION ALL SELECT 'Shift and policy assigned', 'Without these they have no required hours at all.', 'hr', 'setup', 0, TRUE, 100
    UNION ALL SELECT 'Placed in a department and team', 'Unplaced staff fall outside every department-based rule.', 'hr', 'setup', 0, TRUE, 110
    UNION ALL SELECT 'Statutory enrolment', 'PF, ESI and UAN where they apply.', 'finance', 'statutory', 7, TRUE, 120
    UNION ALL SELECT 'Induction and safety training', 'Completed and recorded.', 'manager', 'training', 5, FALSE, 130
    UNION ALL SELECT 'Policies acknowledged', 'Read and accepted.', 'employee', 'paperwork', 5, FALSE, 140
    UNION ALL SELECT 'Buddy assigned', 'Someone to ask the small questions.', 'manager', 'training', 1, FALSE, 150
    UNION ALL SELECT 'Probation review date set', 'Otherwise probation lapses quietly into permanence.', 'hr', 'setup', 7, FALSE, 160
  ) AS x
 WHERE tpl.name = 'Standard joining' AND tpl.direction = 'onboarding'
   AND NOT EXISTS (SELECT 1 FROM onboarding_template_tasks e
                    WHERE e.template_id = tpl.id AND e.title = x.title);

-- ---------------------------------------------------------------------------
-- 7. The default leaving checklist
--
-- Access revocation is blocking and dated to the last day, because every day
-- it slips is a day somebody who has left can still sign in.
-- ---------------------------------------------------------------------------
INSERT INTO onboarding_templates (name, direction, description, is_default)
SELECT * FROM (SELECT 'Standard leaving' AS n, 'offboarding' AS d,
  'The default checklist when somebody leaves.' AS de, TRUE AS df) AS t
WHERE NOT EXISTS (SELECT 1 FROM onboarding_templates
                   WHERE name = 'Standard leaving' AND direction = 'offboarding');

INSERT INTO onboarding_template_tasks
  (template_id, title, description, owner_role, category, due_offset_days, is_blocking, sort_order)
SELECT tpl.id, x.title, x.descr, x.owner, x.cat, x.offs, x.blocking, x.srt
  FROM onboarding_templates tpl
  JOIN (
    SELECT 'Resignation or notice recorded' AS title, 'In writing, with the agreed last working day.' AS descr,
           'hr' AS owner, 'paperwork' AS cat, -30 AS offs, TRUE AS blocking, 10 AS srt
    UNION ALL SELECT 'Handover completed', 'Work, accounts and contacts passed on.', 'manager', 'handover', -5, TRUE, 20
    UNION ALL SELECT 'Assets returned', 'Laptop, SIM, keys, ID card, protective equipment.', 'it', 'assets', 0, TRUE, 30
    UNION ALL SELECT 'App access revoked', 'Account deactivated and passkeys removed. Every day this slips is a day a leaver can still sign in.', 'it', 'access', 0, TRUE, 40
    UNION ALL SELECT 'Email and system accounts closed', 'Including anything outside this app.', 'it', 'access', 0, TRUE, 50
    UNION ALL SELECT 'Final attendance settled', 'Last month closed and any shortfall or overtime agreed.', 'hr', 'setup', 1, TRUE, 60
    UNION ALL SELECT 'Leave balance settled', 'Encashed or forfeited, and recorded either way.', 'finance', 'setup', 3, FALSE, 70
    UNION ALL SELECT 'Final settlement paid', 'Salary, dues and deductions.', 'finance', 'setup', 15, TRUE, 80
    UNION ALL SELECT 'Experience letter issued', 'They will need it.', 'hr', 'paperwork', 7, FALSE, 90
    UNION ALL SELECT 'Exit interview held', 'The only chance to hear why.', 'hr', 'handover', -2, FALSE, 100
  ) AS x
 WHERE tpl.name = 'Standard leaving' AND tpl.direction = 'offboarding'
   AND NOT EXISTS (SELECT 1 FROM onboarding_template_tasks e
                    WHERE e.template_id = tpl.id AND e.title = x.title);

-- ---------------------------------------------------------------------------
-- 8. Correct ownership on templates already created
--
-- The seeds above are guarded on the task title, so editing them does not
-- reach a template that exists. These three are the new starter's own actions
-- - nobody else can install an app on their phone or acknowledge a policy on
-- their behalf - and leaving them owned by HR made the whole employee
-- self-service path unreachable: every task belonged to somebody else, so an
-- employee could never tick anything.
-- ---------------------------------------------------------------------------
UPDATE onboarding_template_tasks
   SET owner_role = 'employee'
 WHERE title IN ('Emergency contact recorded', 'Attendance app installed', 'Policies acknowledged')
   AND owner_role <> 'employee';
