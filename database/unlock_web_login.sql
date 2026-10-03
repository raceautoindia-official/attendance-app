-- =============================================================================
-- LOCKED OUT OF THE WEB APP? Run this.
--
--   mysql -u <user> -p <database> < database/unlock_web_login.sql
--
-- Signing in to the WEB app needs one of two things:
--
--   • a passkey registered for the account, OR
--   • a passkey EXEMPTION, which allows PIN-only sign-in
--
-- With neither, /api/auth/login answers "requiresPasskeySetup" and the login
-- screen shows "Passkey setup required. Please contact your administrator" —
-- with no way forward. If the person locked out IS the administrator, nobody
-- can grant it through the UI, and this SQL is the only way back in.
--
-- (The MOBILE app is unaffected: it is PIN-only by design, so employees can
-- always sign in there.)
-- =============================================================================

-- The tables are utf8mb4_unicode_ci, but the mysql CLI on MySQL 8 connects as
-- utf8mb4_0900_ai_ci — and comparing a user variable against a column across
-- those two collations is an error, not a silent coercion. Pin the connection
-- to the tables' collation so @variables match. (The app's own driver already
-- negotiates utf8mb4_unicode_ci, which is why this only bites from the CLI.)
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;


-- 1. WHO CAN ACTUALLY SIGN IN ON THE WEB? -------------------------------------
SELECT
  e.emp_id,
  e.name,
  e.role,
  (SELECT COUNT(*) FROM passkeys p
     WHERE p.employee_id = e.id)                                   AS passkeys,
  (SELECT COUNT(*) FROM passkey_exemptions x
     WHERE x.employee_id = e.id AND x.is_active = TRUE)            AS pin_exemption,
  CASE
    WHEN (SELECT COUNT(*) FROM passkeys p WHERE p.employee_id = e.id) > 0
      THEN 'passkey required at sign-in'
    WHEN (SELECT COUNT(*) FROM passkey_exemptions x
            WHERE x.employee_id = e.id AND x.is_active = TRUE) > 0
      THEN 'PIN only - can sign in'
    ELSE '*** LOCKED OUT ***'
  END AS web_login
FROM employees e
WHERE e.is_active = TRUE
ORDER BY FIELD(e.role,'super_admin','manager','employee'), e.emp_id;


-- 2. UNLOCK ONE ACCOUNT -------------------------------------------------------
-- Replace ADMIN001 with the emp_id that is locked out, then run this block.
-- It grants a PIN-only exemption, which is what every admin account on a fresh
-- install already has. Re-running it is harmless: it will not stack duplicates.

SET @target_emp_id := 'ADMIN001';   -- <<< CHANGE THIS

INSERT INTO passkey_exemptions (employee_id, granted_by, reason, is_active)
SELECT e.id, e.id, 'Web login recovery — granted directly in the database', TRUE
FROM employees e
WHERE e.emp_id = @target_emp_id
  AND e.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM passkey_exemptions x
    WHERE x.employee_id = e.id AND x.is_active = TRUE
  );

SELECT ROW_COUNT() AS exemption_granted,
       IF(ROW_COUNT() = 1,
          CONCAT(@target_emp_id, ' can now sign in with just their PIN.'),
          CONCAT(@target_emp_id, ' already had one, or the emp_id was not found — check section 1.')
       ) AS result;


-- 3. CONFIRM ------------------------------------------------------------------
SELECT e.emp_id, e.name,
       IF((SELECT COUNT(*) FROM passkey_exemptions x
             WHERE x.employee_id = e.id AND x.is_active = TRUE) > 0,
          'PIN sign-in enabled', 'still locked out') AS state
FROM employees e
WHERE e.emp_id = @target_emp_id;


-- -----------------------------------------------------------------------------
-- NOTE ON PASSKEYS
--
-- If section 1 shows passkeys > 0 but sign-in still fails, the credential on
-- the DEVICE is gone (browser data cleared, different machine, profile reset)
-- while the server row remains — so the app asks for a passkey the device can
-- no longer produce. Granting the exemption above restores PIN sign-in. To
-- clear the stale credential as well:
--
--   DELETE FROM passkeys WHERE employee_id =
--     (SELECT id FROM employees WHERE emp_id = 'ADMIN001');
--
-- Once back in, register a fresh passkey from the app if you want the second
-- factor, and revoke the exemption from the admin UI.
-- -----------------------------------------------------------------------------
