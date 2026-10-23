import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('SQLite backup is a consistent standalone database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudbridge-backup-test-'));
  const source = join(directory, 'source.db');
  const destination = join(directory, 'backup.db');
  try {
    const db = new DatabaseSync(source);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\'durable\');');
    db.close();
    execFileSync(process.execPath, [join(process.cwd(), 'server', 'sqlite-backup.mjs'), source, destination], {
      stdio: 'pipe', windowsHide: true,
    });
    const backup = new DatabaseSync(destination, { readOnly: true });
    assert.equal(backup.prepare('SELECT value FROM records').get().value, 'durable');
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    backup.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
