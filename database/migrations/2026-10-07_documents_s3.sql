-- =============================================================================
-- 2026-10-07 - Store employee documents in S3 rather than the database
--
--   mysql -u <user> -p <database> < database/migrations/2026-10-07_documents_s3.sql
--
-- WHY
-- ---
-- `employee_documents.file_data` is a LONGTEXT holding base64. That works, and
-- it is the reason the upload limit is 3 MB: nginx caps a request body at 5 MB
-- and base64 inflates a file by a third, so a 3 MB PDF is already close to the
-- ceiling. Every read also pulls the whole file through the app and the
-- database connection.
--
-- Aadhaar cards, PAN cards and scanned government IDs are exactly the documents
-- that arrive as large photographs, so the limit bites in practice.
--
-- With S3 the browser uploads straight to the bucket using a presigned URL -
-- past nginx entirely - and downloads come back as short-lived presigned links.
-- The database then holds metadata and a key, not megabytes of base64.
--
-- BOTH PATHS STAY
-- ---------------
-- `storage` says where each row's bytes actually are. Rows written before this
-- migration are 'db' and keep working untouched; new rows are 's3' only when a
-- bucket is configured, and fall back to 'db' when it is not. An unconfigured
-- deployment therefore behaves exactly as it does today rather than failing to
-- upload - the same rule as policies and the unpaid-break column.
--
-- file_data becomes NULLable, since an S3 row has no inline bytes. Widening a
-- NOT NULL column to NULL cannot invalidate an existing row.
--
-- Idempotent - safe to re-run.
-- =============================================================================

-- --- storage ---------------------------------------------------------------
SET @has_storage := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
     AND COLUMN_NAME = 'storage'
);
SET @sql := IF(@has_storage = 0,
  'ALTER TABLE employee_documents
     ADD COLUMN storage ENUM(''db'',''s3'') NOT NULL DEFAULT ''db''
       COMMENT "Where the bytes are. Existing rows are db and stay that way."
       AFTER file_data',
  'SELECT ''employee_documents.storage already present'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- s3_key ----------------------------------------------------------------
SET @has_key := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
     AND COLUMN_NAME = 's3_key'
);
SET @sql := IF(@has_key = 0,
  'ALTER TABLE employee_documents
     ADD COLUMN s3_key VARCHAR(500) NULL
       COMMENT "Object key within the bucket. NULL for db-stored rows."
       AFTER storage',
  'SELECT ''employee_documents.s3_key already present'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- file_data may now be empty --------------------------------------------
-- An S3 row holds no inline bytes. Widening NOT NULL to NULL cannot invalidate
-- any row that already exists.
SET @is_nullable := (
  SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
     AND COLUMN_NAME = 'file_data'
);
SET @sql := IF(@is_nullable = 'NO',
  'ALTER TABLE employee_documents MODIFY COLUMN file_data LONGTEXT NULL
     COMMENT "Base64 bytes for storage=db. NULL when the file lives in S3."',
  'SELECT ''employee_documents.file_data is already nullable'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- --- an unfinished upload must be findable ---------------------------------
-- A presigned upload is recorded before the browser has finished sending the
-- bytes, so a row can exist whose object never arrived. This index makes the
-- sweep for those cheap.
SET @has_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents'
     AND INDEX_NAME = 'idx_doc_storage_created'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE employee_documents ADD INDEX idx_doc_storage_created (storage, created_at)',
  'SELECT ''idx_doc_storage_created already present'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT 'storage column' AS what, COUNT(*) AS present, 'must be 1' AS detail
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'storage';

SELECT 's3_key column' AS what, COUNT(*) AS present, 'must be 1' AS detail
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 's3_key';

SELECT 'file_data nullable' AS what, IS_NULLABLE AS present, 'must be YES' AS detail
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_documents' AND COLUMN_NAME = 'file_data';

SELECT 'documents by storage' AS what,
       CONCAT(COALESCE(SUM(storage = 'db'), 0), ' in database, ',
              COALESCE(SUM(storage = 's3'), 0), ' in S3') AS present,
       'existing rows keep working exactly as they are' AS detail
  FROM employee_documents;
