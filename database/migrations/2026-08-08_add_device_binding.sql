-- ---------------------------------------------------------------------------
-- Bind attendance to the employee's own phone.
--
-- "Mobile only" was enforced from the User-Agent, which the client chooses —
-- a desktop script sending an Android user-agent was accepted. A device id
-- stored in the app's secure storage is not proof of a phone either, but it is
-- per-install and per-employee: the first device to clock in is remembered, and
-- a second one is refused until an admin releases it. That turns a silent
-- bypass into something an admin sees and has to act on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_devices (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   INT          NOT NULL,
  device_id     VARCHAR(128) NOT NULL,
  platform      VARCHAR(32)  NULL,
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at   DATETIME     NULL COMMENT 'Set when an admin unbinds it (new phone, lost device)',
  released_by   INT          NULL,
  UNIQUE KEY uniq_employee_device (employee_id, device_id),
  KEY idx_employee_active (employee_id, released_at),
  CONSTRAINT fk_devices_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_released_by FOREIGN KEY (released_by) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
