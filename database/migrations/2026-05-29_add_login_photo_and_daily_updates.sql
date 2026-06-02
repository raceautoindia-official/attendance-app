USE attendance;

CREATE TABLE IF NOT EXISTS login_photo_proofs (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  employee_id   INT          NOT NULL,
  captured_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  image_data    MEDIUMTEXT   NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_login_photo_proofs_employee_id (employee_id),
  INDEX idx_login_photo_proofs_captured_at (captured_at),
  CONSTRAINT fk_login_photo_proofs_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_work_updates (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  employee_id   INT          NOT NULL,
  work_date     DATE         NOT NULL,
  update_text   VARCHAR(1000) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_work_updates_employee_date (employee_id, work_date),
  INDEX idx_daily_work_updates_work_date (work_date),
  CONSTRAINT fk_daily_work_updates_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
