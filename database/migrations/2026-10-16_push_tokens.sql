-- =============================================================================
-- push_tokens — where to send a push notification for each signed-in phone
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-16_push_tokens.sql
--
-- Every notification the app showed was LOCAL: the phone asked the server for
-- news and announced what it found. With the app open that happens every
-- minute; closed, only when Android lets a background task run — which on most
-- phones means hours later or not at all. So a permission approval reached the
-- employee when they next opened the app, which is exactly the complaint.
--
-- A push is sent by the server the moment something happens and delivered by
-- Firebase Cloud Messaging whether or not the app is running. This table holds
-- each phone's push address (its FCM registration token) against the employee
-- signed in on it.
--
-- One row per token. A phone that changes hands moves its row to the new
-- employee (the token is unique); signing out deletes it; a token the push
-- service reports as dead is deleted the first time a send finds out.
--
-- The app works without this table — it just keeps announcing on its own, as
-- before. Safe to re-run.
-- =============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS push_tokens (
  id            INT          NOT NULL AUTO_INCREMENT,
  employee_id   INT          NOT NULL,
  -- FCM registration token — an address, not a secret. Usually ~160
  -- characters; Google promises no fixed length, hence the room.
  token         VARCHAR(512) NOT NULL,
  -- The install it came from (x-device-id), so signing out of one phone
  -- removes that phone's address and no other.
  device_id     VARCHAR(128) NULL,
  platform      VARCHAR(16)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_push_token (token),
  KEY idx_push_employee (employee_id),
  CONSTRAINT fk_push_tokens_employee
    FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
