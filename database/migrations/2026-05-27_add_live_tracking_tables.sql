CREATE TABLE IF NOT EXISTS live_tracking_sessions (
  id              BIGINT   NOT NULL AUTO_INCREMENT,
  employee_id     INT      NOT NULL,
  started_at_utc  DATETIME NOT NULL,
  ended_at_utc    DATETIME NULL,
  is_active       BOOLEAN  NOT NULL DEFAULT TRUE,
  last_ping_utc   DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_live_tracking_sessions_employee_id (employee_id),
  INDEX idx_live_tracking_sessions_is_active   (is_active),
  INDEX idx_live_tracking_sessions_started_at  (started_at_utc),
  CONSTRAINT fk_live_tracking_sessions_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS live_tracking_points (
  id               BIGINT         NOT NULL AUTO_INCREMENT,
  session_id       BIGINT         NOT NULL,
  employee_id      INT            NOT NULL,
  tracked_at_utc   DATETIME       NOT NULL,
  latitude         DECIMAL(10,7)  NOT NULL,
  longitude        DECIMAL(10,7)  NOT NULL,
  accuracy_meters  DECIMAL(8,2)   NULL,
  PRIMARY KEY (id),
  INDEX idx_live_tracking_points_session_id     (session_id),
  INDEX idx_live_tracking_points_employee_id    (employee_id),
  INDEX idx_live_tracking_points_tracked_at_utc (tracked_at_utc),
  CONSTRAINT fk_live_tracking_points_session
    FOREIGN KEY (session_id) REFERENCES live_tracking_sessions (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_live_tracking_points_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
