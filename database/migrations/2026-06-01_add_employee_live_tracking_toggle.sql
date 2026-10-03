-- (no USE statement: the target database is selected by the caller,
--  e.g. `mysql -u <user> -p <database> < this-file.sql`. A hardcoded
--  USE breaks any deployment whose database is named differently.)

ALTER TABLE employees
  ADD COLUMN live_tracking_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active;

