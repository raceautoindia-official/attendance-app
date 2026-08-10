-- =============================================================================
-- 2026-08-04 — Permission hours (short paid absence during a working day)
--
-- An employee applies for a slice of hours off (e.g. 10:00–12:00) from the app;
-- a manager / super admin approves or rejects it. Approved minutes top the
-- day's worked hours back up to the required shift length, so a late arrival or
-- early departure covered by permission is not short-hours.
--
--   credited = LEAST(worked + approved_permission, GREATEST(worked, required))
--
-- Monthly entitlement is enforced in the app layer (PERMISSION_* constants in
-- lib/constants.ts, default 120 minutes per month, 120 per request).
--
-- Not idempotent — run once.
-- =============================================================================

CREATE TABLE permission_requests (
  id               INT          NOT NULL AUTO_INCREMENT,
  employee_id      INT          NOT NULL,
  permission_date  DATE         NOT NULL,
  -- IST wall-clock times; the pair is stored as given and `minutes` is derived
  -- once at write time so reports never re-do the arithmetic.
  start_time       TIME         NOT NULL,
  end_time         TIME         NOT NULL,
  minutes          INT          NOT NULL,
  reason           VARCHAR(500) NULL,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  -- Who applied: the employee themself, or an admin filing on their behalf
  -- (in which case the row is created already approved).
  requested_by     INT          NULL,
  reviewed_by      INT          NULL,
  reviewed_at      DATETIME     NULL,
  review_notes     VARCHAR(500) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_permission_requests_employee_date (employee_id, permission_date),
  INDEX idx_permission_requests_date          (permission_date),
  INDEX idx_permission_requests_status        (status),
  INDEX idx_permission_requests_reviewed_by   (reviewed_by),

  CONSTRAINT fk_permission_requests_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_permission_requests_requested_by
    FOREIGN KEY (requested_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_permission_requests_reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
