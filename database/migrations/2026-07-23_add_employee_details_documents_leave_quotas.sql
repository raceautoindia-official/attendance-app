-- =============================================================================
-- 2026-07-23 — Employee bank/identity details, document uploads, yearly leave quotas
--
-- Run against the attendance database, e.g.:
--   mysql -u <user> -p <database> < database/migrations/2026-07-23_add_employee_details_documents_leave_quotas.sql
--
-- Note: the ALTER TABLE below is not idempotent (MySQL has no
-- "ADD COLUMN IF NOT EXISTS") — run it once. The CREATE TABLEs are safe to
-- re-run.
-- =============================================================================

-- 1. Bank + statutory identity fields on employees
ALTER TABLE employees
  ADD COLUMN bank_account_name   VARCHAR(100) NULL AFTER department,
  ADD COLUMN bank_account_number VARCHAR(24)  NULL AFTER bank_account_name,
  ADD COLUMN bank_ifsc           VARCHAR(11)  NULL AFTER bank_account_number,
  ADD COLUMN bank_name           VARCHAR(100) NULL AFTER bank_ifsc,
  ADD COLUMN pan_number          VARCHAR(10)  NULL AFTER bank_name,
  ADD COLUMN aadhaar_number      VARCHAR(12)  NULL AFTER pan_number;

-- 2. Uploaded documents (PAN card, Aadhaar card, experience certificates, …).
--    file_data holds the file as base64 (same storage pattern as
--    login_photo_proofs.image_data). Served only through the authenticated
--    download API — never publicly.
CREATE TABLE IF NOT EXISTS employee_documents (
  id           INT           NOT NULL AUTO_INCREMENT,
  employee_id  INT           NOT NULL,
  doc_type     ENUM('pan_card','aadhaar_card','bank_proof','experience_certificate','relieving_letter','education_certificate','offer_letter','other') NOT NULL DEFAULT 'other',
  title        VARCHAR(150)  NOT NULL,
  file_name    VARCHAR(255)  NOT NULL,
  mime_type    VARCHAR(100)  NOT NULL,
  size_bytes   INT           NOT NULL,
  file_data    LONGTEXT      NOT NULL,
  uploaded_by  INT           NULL,
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_employee_documents_employee_id (employee_id),
  INDEX idx_employee_documents_doc_type    (doc_type),

  CONSTRAINT fk_employee_documents_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_employee_documents_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Yearly leave quotas — per employee per calendar year. "Used" counts are
--    derived live from leave_records, so only the totals are stored here.
CREATE TABLE IF NOT EXISTS leave_quotas (
  id            INT       NOT NULL AUTO_INCREMENT,
  employee_id   INT       NOT NULL,
  year          SMALLINT  NOT NULL,
  casual_total  INT       NOT NULL DEFAULT 0,
  sick_total    INT       NOT NULL DEFAULT 0,
  earned_total  INT       NOT NULL DEFAULT 0,
  updated_by    INT       NULL,
  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_quotas_emp_year (employee_id, year),
  INDEX idx_leave_quotas_year (year),

  CONSTRAINT fk_leave_quotas_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_leave_quotas_updated_by
    FOREIGN KEY (updated_by) REFERENCES employees (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
