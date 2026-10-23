import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { startPolicyWorker } from '../server/proxy-adapter.mjs';

test('policy worker retries transient adapter failures and marks the job processed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudbridge-policy-test-'));
  const db = openDatabase(join(directory, 'test.db'));
  let attempts = 0;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO members(id, name, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('member-1', 'Retry test', new Date(Date.now() + 86_400_000).toISOString(), now, now);
  db.prepare(`INSERT INTO policy_jobs(member_id, action, payload, created_at) VALUES (?, ?, '{}', ?)`)
    .run('member-1', 'member.created', now);
  const adapter = {
    async syncMember() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary outage');
    },
    async syncUsage() {},
  };
  const stop = startPolicyWorker(db, {
    adapter, encryptionKey: 'unused', intervalMs: 15, retryBaseMs: 15,
    reconcileMs: 60_000, usageSyncMs: 60_000,
  });
  try {
    const deadline = Date.now() + 2_000;
    let row;
    while (Date.now() < deadline) {
      row = db.prepare('SELECT * FROM policy_jobs WHERE member_id = ?').get('member-1');
      if (row.status === 'processed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(row.status, 'processed');
    assert.equal(row.attempts, 1);
    assert.equal(attempts, 2);
  } finally {
    stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
