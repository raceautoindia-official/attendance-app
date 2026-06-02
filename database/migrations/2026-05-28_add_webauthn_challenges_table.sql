CREATE TABLE IF NOT EXISTS webauthn_challenges (
  emp_id      VARCHAR(20)  NOT NULL,
  challenge   VARCHAR(255) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (emp_id),
  INDEX idx_webauthn_challenges_created_at (created_at),
  CONSTRAINT fk_webauthn_challenges_employee
    FOREIGN KEY (emp_id) REFERENCES employees (emp_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
