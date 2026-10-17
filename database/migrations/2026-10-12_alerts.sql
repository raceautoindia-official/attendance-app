-- ---------------------------------------------------------------------------
-- 2026-10-12_alerts.sql
--
-- Things worth telling somebody about, without anybody going looking.
--
-- WHAT THIS IS FOR
-- ----------------
-- Every other view answers a question you already thought to ask. The month
-- review answers one you did not - but only once a month, and only if somebody
-- opens it. Repeated lateness, heavy leave and a person who simply has not
-- clocked in are all facts the database already knows this morning, and
-- nothing in the app said them out loud.
--
-- IT ARRIVES INERT, AND THAT IS DELIBERATE
-- ----------------------------------------
-- The pattern rules read their thresholds from the POLICY, and every threshold
-- column added here is NULLable with no default. NULL means the rule is off.
-- So applying this migration changes nobody's experience until an
-- administrator sets a number on a policy, which is the same discipline the
-- policy system itself shipped under.
--
-- The alternative - sensible defaults for everyone - would mean the morning
-- after deployment somebody finds forty alerts about people they already know
-- are on flexible hours. Alert fatigue is the failure mode that kills this
-- kind of feature, and it kills it in the first week.
--
-- WHAT IT DOES NOT DUPLICATE
-- --------------------------
-- No rule restates anything the inbox already carries: pending permission
-- requests, correction requests and unreviewed off-site clock-ins are read
-- straight from their own tables by lib/inbox.ts. Alerts are for facts with no
-- request behind them.
--
-- Additive only. Nothing is renamed or re-typed; the mobile app shares this
-- database and reads these tables.
--
-- Pure ASCII: the mysql client's charset is whatever the server's shell
-- defaults to, and a UTF-8 file read as latin1 stores mojibake permanently.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The catalogue
--
-- The rules themselves are code - each is a query and a sentence. What lives
-- here is whether each one is switched on, so turning a noisy rule off does
-- not need a deployment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
  rule_key    VARCHAR(40) PRIMARY KEY,
  label       VARCHAR(120) NOT NULL,
  description VARCHAR(400) NOT NULL,
  family      ENUM('live','pattern','lifecycle') NOT NULL,
  is_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. The alerts
--
-- ONE ROW PER EMPLOYEE PER RULE PER PERIOD, updated rather than re-inserted.
-- A week of lateness is one alert with a rising count, not seven rows nobody
-- reads to the bottom of.
--
-- employee_key exists because a unique key containing a NULLable column does
-- not dedupe in MySQL - NULL != NULL - and company-level alerts (a month
-- nobody has closed) have no employee. That exact mistake put two identical
-- rows in holiday_countries earlier in this project.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  rule_key      VARCHAR(40) NOT NULL,
  -- NULL for a fact about the company rather than a person.
  employee_id   INT NULL,
  -- VIRTUAL, not STORED: MySQL refuses ON DELETE CASCADE on a column that a
  -- STORED generated column is built from (ERROR 1215, which is how this was
  -- found). A virtual column still carries a unique index, which is the only
  -- thing it is here for - holiday_countries does the same.
  employee_key  INT GENERATED ALWAYS AS (COALESCE(employee_id, 0)) VIRTUAL,
  -- '2026-10' for a month, '2026-10-12' for a day, 'standing' for a fact with
  -- no period. Part of the unique key, so re-running a day is idempotent.
  period_key    VARCHAR(16) NOT NULL,
  severity      ENUM('critical','warning','info') NOT NULL DEFAULT 'warning',
  state         ENUM('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
  title         VARCHAR(200) NOT NULL,
  body          VARCHAR(500) NOT NULL,
  -- The numbers behind the sentence, so a reader can check it rather than
  -- believe it, and so the wording can change without losing the evidence.
  detail        JSON NULL,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_by  INT NULL,
  acknowledged_at  DATETIME NULL,
  -- "Spoke to him, hospital visit" is the outcome of most of these, and it
  -- belongs on the record rather than in somebody's memory.
  acknowledge_note VARCHAR(500) NULL,
  -- Hidden until this date. For a fact that is known, accepted, and not worth
  -- being told again this week.
  snoozed_until DATE NULL,
  resolved_at   DATETIME NULL,
  UNIQUE KEY uq_alert (rule_key, employee_key, period_key),
  KEY idx_alert_open (state, severity, last_seen_at),
  KEY idx_alert_employee (employee_id, state),
  CONSTRAINT fk_alert_employee FOREIGN KEY (employee_id)
    REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. What was sent, and to whom
--
-- So a digest cannot go out twice, and so "nobody told me" has an answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  channel      ENUM('email') NOT NULL,
  recipient_id INT NULL,
  recipient    VARCHAR(160) NOT NULL,
  -- The day the digest covers, so one send per recipient per day.
  period_key   VARCHAR(16) NOT NULL,
  alert_count  INT NOT NULL DEFAULT 0,
  sent_at      DATETIME NULL,
  error        VARCHAR(400) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_delivery (channel, recipient, period_key),
  KEY idx_delivery_period (period_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Thresholds, on the policy
--
-- Not in a settings table: a plant and an office do not share a view of what
-- counts as late, and the policy is already the thing that says what a group
-- of people is measured by. Nullable with no default - NULL is off.
-- ---------------------------------------------------------------------------
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies'
    AND COLUMN_NAME = 'late_alert_days_per_month');
SET @sql := IF(@have = 0,
  'ALTER TABLE policies ADD COLUMN late_alert_days_per_month TINYINT UNSIGNED NULL
     COMMENT ''Alert when late on this many days in a month. NULL = off.''
     AFTER late_grace_minutes',
  'SELECT ''policies.late_alert_days_per_month already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies'
    AND COLUMN_NAME = 'leave_alert_days_per_month');
SET @sql := IF(@have = 0,
  'ALTER TABLE policies ADD COLUMN leave_alert_days_per_month TINYINT UNSIGNED NULL
     COMMENT ''Alert when leave reaches this many days in a month. NULL = off.''
     AFTER late_alert_days_per_month',
  'SELECT ''policies.leave_alert_days_per_month already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- Minutes AFTER the shift start and its grace period. A flexible shift has no
-- start to count from, so the rule skips those people entirely rather than
-- calling them late at nine every morning.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies'
    AND COLUMN_NAME = 'missing_clockin_alert_minutes');
SET @sql := IF(@have = 0,
  'ALTER TABLE policies ADD COLUMN missing_clockin_alert_minutes SMALLINT UNSIGNED NULL
     COMMENT ''Alert when nobody has clocked in this many minutes past the grace period. NULL = off.''
     AFTER leave_alert_days_per_month',
  'SELECT ''policies.missing_clockin_alert_minutes already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- A fraction, e.g. 0.750. The month review already uses 0.75 as the line where
-- an average becomes a pattern; this makes it settable per policy.
SET @have := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'policies'
    AND COLUMN_NAME = 'low_hours_alert_ratio');
SET @sql := IF(@have = 0,
  'ALTER TABLE policies ADD COLUMN low_hours_alert_ratio DECIMAL(4,3) NULL
     COMMENT ''Alert when credited hours fall below this fraction of required. NULL = off.''
     AFTER missing_clockin_alert_minutes',
  'SELECT ''policies.low_hours_alert_ratio already present''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 5. The rule catalogue, seeded
--
-- Enabled where the rule is about the company's own housekeeping and cannot
-- be about a person's character; off where it is about people, until somebody
-- sets a threshold and means it.
--
-- The three rules with a threshold are listed as enabled because a NULL
-- threshold already makes them inert - switching them off here as well would
-- mean setting a number on a policy appeared to do nothing.
-- ---------------------------------------------------------------------------
INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'not_clocked_in' AS k,
  'Not clocked in' AS l,
  'Somebody rostered to work today has not clocked in, and the grace period plus the policy allowance has passed. Skips flexible shifts, week offs, holidays, leave and approved permissions.' AS d,
  'live' AS f, TRUE AS e) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'not_clocked_in');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'late_pattern', 'Repeated lateness',
  'Late on more days this month than the policy allows. Counts the same days the reports count, and never fires where lateness cannot be measured.',
  'pattern', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'late_pattern');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'leave_pattern', 'Heavy leave',
  'Leave this month has reached the number of days the policy says is worth a conversation. Company holidays are not counted.',
  'pattern', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'leave_pattern');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'low_hours_pattern', 'Hours well below the roster',
  'Credited hours this month are below the fraction of required hours the policy sets. Needs several days before it means anything.',
  'pattern', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'low_hours_pattern');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'probation_ending', 'Probation ending',
  'A probation period ends within a fortnight and somebody has to decide what happens next.',
  'lifecycle', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'probation_ending');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'onboarding_overdue', 'Checklist task overdue',
  'A joining or leaving task is past its due date. Blocking tasks are reported as critical.',
  'lifecycle', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'onboarding_overdue');

INSERT INTO alert_rules (rule_key, label, description, family, is_enabled)
SELECT * FROM (SELECT 'month_not_closed', 'Month still open',
  'Last month has not been closed, so its figures can still change after they have been used.',
  'lifecycle', TRUE) AS t
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE rule_key = 'month_not_closed');

-- ---------------------------------------------------------------------------
-- 6. Who may see and clear them
-- ---------------------------------------------------------------------------
INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'alerts.view' AS k, 'See alerts' AS l,
  'Repeated lateness, heavy leave, nobody clocked in, and the rest.' AS d,
  'attendance' AS c, TRUE AS s, 25 AS o) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'alerts.view');

INSERT INTO permissions (perm_key, label, description, category, scopable, sort_order)
SELECT * FROM (SELECT 'alerts.manage', 'Clear and configure alerts',
  'Acknowledge an alert with a note, snooze it, and switch rules on or off.',
  'attendance', TRUE, 26) AS t
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE perm_key = 'alerts.manage');

-- A manager sees and clears alerts for their own department, the same scope
-- they already have for attendance. Without this line, granting somebody the
-- manager role would hide the inbox from them.
INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'department'
  FROM roles r JOIN permissions p
 WHERE r.code = 'manager'
   AND p.perm_key IN ('alerts.view', 'alerts.manage')
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = p.id);

INSERT INTO role_permissions (role_id, permission_id, scope)
SELECT r.id, p.id, 'all'
  FROM roles r JOIN permissions p
 WHERE r.code = 'super_admin'
   AND p.perm_key IN ('alerts.view', 'alerts.manage')
   AND NOT EXISTS (SELECT 1 FROM role_permissions x
                    WHERE x.role_id = r.id AND x.permission_id = p.id);
