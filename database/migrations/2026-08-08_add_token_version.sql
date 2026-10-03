-- ---------------------------------------------------------------------------
-- Make logout actually revoke access.
--
-- Logging out deleted the refresh tokens but left the access token valid until
-- it expired — with an 8h/24h lifetime, a token lifted from a device kept
-- working for the rest of the day even after the employee "logged out".
--
-- Every access token now carries the employee's token_version. Logging out (or
-- an admin deactivating someone, or a PIN change) bumps the column, and every
-- token issued before that stops verifying immediately.
-- ---------------------------------------------------------------------------

ALTER TABLE employees
  ADD COLUMN token_version INT NOT NULL DEFAULT 0
  COMMENT 'Bumped to invalidate all previously issued access tokens';
