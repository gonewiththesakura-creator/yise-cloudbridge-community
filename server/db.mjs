import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      totp_secret_encrypted TEXT,
      totp_pending_encrypted TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      mfa_verified INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'revoked')),
      expires_at TEXT NOT NULL,
      traffic_quota_bytes INTEGER NOT NULL DEFAULT 0,
      traffic_used_bytes INTEGER NOT NULL DEFAULT 0,
      max_connections INTEGER NOT NULL DEFAULT 2,
      credential_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      public_key_hash TEXT NOT NULL UNIQUE,
      fingerprint_hash TEXT NOT NULL,
      key_provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      enrolled_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_device_per_member
      ON devices(member_id) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS activation_codes (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_challenges (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      nonce_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_credentials (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      encrypted_payload TEXT NOT NULL,
      sui_client_id INTEGER,
      sui_client_name TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(member_id, revision)
    );

    CREATE TABLE IF NOT EXISTS device_certificates (
      fingerprint_sha256 TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      serial_number TEXT NOT NULL UNIQUE,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processed', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traffic_samples (
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      bucket_start TEXT NOT NULL,
      traffic_total_bytes INTEGER NOT NULL DEFAULT 0,
      upload_total_bytes INTEGER NOT NULL DEFAULT 0,
      download_total_bytes INTEGER NOT NULL DEFAULT 0,
      traffic_delta_bytes INTEGER NOT NULL DEFAULT 0,
      upload_delta_bytes INTEGER NOT NULL DEFAULT 0,
      download_delta_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(member_id, bucket_start)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS challenges_by_device ON device_challenges(device_id, expires_at);
    CREATE INDEX IF NOT EXISTS credentials_by_member ON proxy_credentials(member_id, revision);
    CREATE INDEX IF NOT EXISTS certificates_by_device ON device_certificates(device_id, expires_at);
    CREATE INDEX IF NOT EXISTS jobs_by_status ON policy_jobs(status, id);
    CREATE INDEX IF NOT EXISTS traffic_samples_by_time ON traffic_samples(bucket_start);
  `);
  const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map((column) => column.name));
  const migrations = [
    ['public_key_pem', "ALTER TABLE devices ADD COLUMN public_key_pem TEXT NOT NULL DEFAULT ''"],
    ['fingerprint_hash', "ALTER TABLE devices ADD COLUMN fingerprint_hash TEXT NOT NULL DEFAULT ''"],
    ['key_provider', "ALTER TABLE devices ADD COLUMN key_provider TEXT NOT NULL DEFAULT 'unknown'"],
  ];
  for (const [column, sql] of migrations) {
    if (!deviceColumns.has(column)) db.exec(sql);
  }
  const adminColumns = new Set(db.prepare('PRAGMA table_info(admins)').all().map((column) => column.name));
  if (!adminColumns.has('totp_secret_encrypted')) db.exec('ALTER TABLE admins ADD COLUMN totp_secret_encrypted TEXT');
  if (!adminColumns.has('totp_pending_encrypted')) db.exec('ALTER TABLE admins ADD COLUMN totp_pending_encrypted TEXT');
  const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
  // Existing production sessions remain usable during the migration. Every newly issued session sets this explicitly.
  if (!sessionColumns.has('mfa_verified')) db.exec('ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 1');
  const policyColumns = new Set(db.prepare('PRAGMA table_info(policy_jobs)').all().map((column) => column.name));
  if (!policyColumns.has('attempts')) db.exec('ALTER TABLE policy_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!policyColumns.has('next_attempt_at')) db.exec('ALTER TABLE policy_jobs ADD COLUMN next_attempt_at TEXT');
  // Revoked bindings are historical records and must not reserve a fingerprint forever.
  // Keeping the uniqueness constraint on active rows still prevents one live device from
  // being shared across multiple members.
  db.exec(`
    DROP INDEX IF EXISTS unique_device_fingerprint;
    UPDATE devices
      SET public_key_hash = 'revoked:' || id
      WHERE status = 'revoked' AND public_key_hash NOT LIKE 'revoked:%';
    CREATE UNIQUE INDEX IF NOT EXISTS unique_active_device_fingerprint
      ON devices(fingerprint_hash)
      WHERE fingerprint_hash != '' AND status = 'active';
  `);
  // Password-only authentication replaced TOTP. Remove any previously generated shared secrets.
  db.exec(`
    UPDATE admins SET totp_secret_encrypted = NULL, totp_pending_encrypted = NULL
      WHERE totp_secret_encrypted IS NOT NULL OR totp_pending_encrypted IS NOT NULL;
    DELETE FROM admin_recovery_codes;
    UPDATE sessions SET mfa_verified = 1 WHERE mfa_verified != 1;
  `);
  return db;
}

export function closeDatabase(db) {
  db.close();
}
