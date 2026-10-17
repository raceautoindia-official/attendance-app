-- ---------------------------------------------------------------------------
-- database/registry/001_registry.sql
--
-- THE REGISTRY. One database, outside every tenant, holding the only things
-- that cannot live inside one.
--
-- Run against the registry database (default name: worklens_registry), NOT
-- against a tenant. Nothing here is per-company data; nothing here is an
-- employee record.
--
-- It holds exactly two kinds of thing:
--
--   1. Where each tenant's database is, and what state that tenant is in.
--   2. A routing directory: which tenant a given login identifier belongs to.
--
-- The directory exists because "which tenant does this person belong to" has
-- to be answerable BEFORE a tenant database is chosen, and that question
-- cannot be asked inside the answer. It carries no credentials: the PIN hash,
-- the passkeys and the employee record all stay inside the tenant. If this
-- database leaked, it would disclose that a company is a customer and which
-- employee ids exist - not a single password, document or location.
--
-- Pure ASCII on purpose. The mysql client's charset is whatever the server's
-- shell defaults to, and a UTF-8 file read as latin1 stores mojibake
-- permanently - which this project has already been bitten by once.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  -- Short, stable, customer-visible. Used as the tenant code at sign-in and in
  -- support conversations. Never reused, even after deletion.
  code          VARCHAR(40)  NOT NULL,
  name          VARCHAR(200) NOT NULL,

  -- Where this tenant's data actually lives. Tenant one points at the existing
  -- `attendance_db` and that database is not touched, renamed or copied.
  db_name       VARCHAR(64)  NOT NULL,

  -- Null means "the same server the app already connects to". A tenant can
  -- later be moved to its own host by filling these in, with no code change.
  db_host       VARCHAR(255) NULL,
  db_port       INT          NULL,

  status        ENUM('provisioning','active','suspended','archived')
                NOT NULL DEFAULT 'provisioning',

  -- Soft caps, enforced by the application, shown in the provider console.
  plan          VARCHAR(40)  NULL,
  max_employees INT          NULL,

  primary_contact_name  VARCHAR(160) NULL,
  primary_contact_email VARCHAR(190) NULL,

  -- Set when a tenant is suspended, so the reason survives the person who did
  -- it. A suspended tenant can sign nobody in; an archived one is kept only
  -- for its data-retention window.
  status_reason VARCHAR(500) NULL,
  status_changed_at TIMESTAMP NULL,

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_tenant_code (code),
  UNIQUE KEY uk_tenant_db (db_name),
  KEY idx_tenant_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The routing directory
--
-- One row per (login identifier, tenant). An identifier appearing twice means
-- the same emp_id exists at two companies, which is expected - 'ADMIN001' is
-- not going to be unique across customers. Sign-in then asks which
-- organisation instead of guessing, and guessing is the only wrong answer:
-- picking one would hand somebody another company's login prompt.
--
-- Kept in step by the application whenever an employee is created, renamed or
-- deactivated. It is a routing table, not a source of truth, and can be
-- rebuilt from the tenant databases at any time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_login_directory (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT          NOT NULL,

  -- 'emp_id' or 'email'. Both route; neither authenticates.
  id_type     ENUM('emp_id','email') NOT NULL,
  identifier  VARCHAR(190) NOT NULL,

  -- The employee this points at, inside that tenant's database. Carried so a
  -- successful route needs no second lookup, and deliberately not a foreign
  -- key: it references a row in another database.
  employee_id INT          NOT NULL,

  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_directory_entry (id_type, identifier, tenant_id),
  KEY idx_directory_lookup (id_type, identifier, is_active),
  KEY idx_directory_tenant (tenant_id),
  CONSTRAINT fk_directory_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Schema state per tenant
--
-- Migrations are currently hand-run and, as AGENTS.md says, mostly not
-- idempotent. Multiplied across a fleet that is a near-certainty of a
-- half-migrated estate, so from here the fleet records what it has applied.
--
-- `checksum` catches the quiet failure: a migration file edited after it was
-- applied to some tenants and not others. Without it the fleet diverges and
-- every tenant still reports the same filename as applied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_schema_migrations (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT          NOT NULL,
  filename     VARCHAR(255) NOT NULL,
  checksum     CHAR(64)     NOT NULL,
  applied_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms  INT          NULL,
  applied_by   VARCHAR(120) NULL,
  UNIQUE KEY uk_tenant_migration (tenant_id, filename),
  CONSTRAINT fk_migration_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Provider staff, and their access into tenants
--
-- Deliberately separate from `employees`. A provider administrator is not an
-- employee of any customer, and modelling them as one is how somebody ends up
-- appearing in a customer's staff list and their attendance report.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL,
  name          VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('owner','admin','support') NOT NULL DEFAULT 'support',
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMP    NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_provider_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Support access is a grant with an expiry, not a permanent capability.
-- "Our support team may enter your environment, and you will see exactly when
-- they did" is something a customer can accept. Silent access is not, and the
-- difference is this table.
CREATE TABLE IF NOT EXISTS provider_access_grants (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  provider_user_id  INT          NOT NULL,
  tenant_id         INT          NOT NULL,
  reason            VARCHAR(500) NOT NULL,
  granted_by        INT          NULL,
  granted_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        TIMESTAMP    NOT NULL,
  revoked_at        TIMESTAMP    NULL,
  KEY idx_grant_lookup (tenant_id, provider_user_id, expires_at),
  CONSTRAINT fk_grant_user FOREIGN KEY (provider_user_id)
    REFERENCES provider_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_grant_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- An audit log for the provider plane. The tenant's own audit_log records what
-- happened inside it; this records what was done TO it from outside.
CREATE TABLE IF NOT EXISTS provider_audit_log (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  provider_user_id INT          NULL,
  tenant_id        INT          NULL,
  action           VARCHAR(80)  NOT NULL,
  details          JSON         NULL,
  ip_address       VARCHAR(64)  NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_provider_audit_tenant (tenant_id, created_at),
  KEY idx_provider_audit_user (provider_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
