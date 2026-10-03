-- =============================================================================
-- password_resets — emailed PIN-reset links
--
--   mysql -u <user> -p <database> < database/migrations/2026-08-12_add_password_resets.sql
--
-- An employee who forgets their PIN currently has to find an admin. This table
-- backs a self-service reset: request a link, receive it by email, set a new
-- PIN.
--
-- Only the HASH of the token is stored. A database dump (or a careless SELECT
-- over someone's shoulder) must not hand out working reset links, exactly as
-- it must not hand out PINs — the raw token exists only in the email.
--
-- used_at makes a link single-use: following it twice, or after somebody else
-- has already used it, fails. expires_at keeps the window short.
--
-- Safe to re-run.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  employee_id  INT          NOT NULL,
  -- SHA-256 of the raw token; the raw value is never stored anywhere.
  token_hash   CHAR(64)     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  used_at      DATETIME     NULL,
  requested_ip VARCHAR(45)  NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token (token_hash),
  -- The two questions asked: "is this token valid?" and "how many has this
  -- employee requested lately?" (rate limiting).
  KEY idx_password_resets_employee (employee_id, created_at),

  CONSTRAINT fk_password_resets_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_resets'
ORDER BY ORDINAL_POSITION;
