import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { recordTrafficTotals, trafficSeries } from '../server/traffic-usage.mjs';

test('traffic samples preserve an honest baseline and aggregate hourly deltas', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudbridge-traffic-'));
  const db = openDatabase(join(directory, 'traffic.db'));
  const memberId = 'traffic-member';
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO members(id, name, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(memberId, '流量测试', new Date(Date.now() + 86_400_000).toISOString(), createdAt, createdAt);
  try {
    const thisHour = new Date();
    thisHour.setUTCMinutes(5, 0, 0);
    thisHour.setUTCHours(thisHour.getUTCHours() - 1);
    recordTrafficTotals(db, memberId, 1_000, 2_000, thisHour);
    recordTrafficTotals(db, memberId, 1_600, 3_400, new Date(thisHour.getTime() + 10 * 60_000));
    const nextHour = new Date(thisHour.getTime() + 60 * 60_000);
    recordTrafficTotals(db, memberId, 2_000, 4_000, nextHour);
    recordTrafficTotals(db, memberId, 0, 0, new Date(nextHour.getTime() + 10 * 60_000));
    recordTrafficTotals(db, memberId, 200, 300, new Date(nextHour.getTime() + 20 * 60_000));

    const rows = db.prepare('SELECT * FROM traffic_samples ORDER BY bucket_start').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].traffic_delta_bytes, 2_000);
    assert.equal(rows[1].traffic_delta_bytes, 1_500);
    const series = trafficSeries(db, '24h');
    assert.equal(series.points.reduce((sum, point) => sum + point.totalBytes, 0), 3_500);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('member traffic is isolated, missing buckets stay unobserved, and ranges exclude future samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudbridge-traffic-filter-'));
  const db = openDatabase(join(directory, 'traffic.db'));
  const now = new Date('2026-09-12T14:45:00Z');
  try {
    for (const id of ['alice', 'bob', 'empty']) {
      db.prepare('INSERT INTO members(id, name, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, id, '2027-01-01T00:00:00Z', now.toISOString(), now.toISOString());
    }
    recordTrafficTotals(db, 'alice', 100, 200, '2026-09-11T14:00:00Z');
    recordTrafficTotals(db, 'alice', 400, 900, '2026-09-12T13:00:00Z');
    recordTrafficTotals(db, 'alice', 400, 900, '2026-09-12T14:00:00Z');
    recordTrafficTotals(db, 'bob', 10, 20, '2026-09-12T13:00:00Z');
    recordTrafficTotals(db, 'bob', 60, 100, '2026-09-12T14:00:00Z');
    recordTrafficTotals(db, 'bob', 1000, 2000, '2026-09-13T14:00:00Z');
    const alice = trafficSeries(db, '24h', 'alice', now);
    assert.deepEqual(alice.totals, { uploadBytes: 300, downloadBytes: 700, totalBytes: 1000 });
    assert.equal(alice.observedBuckets, 2);
    assert.equal(alice.points[0].observed, false);
    assert.equal(alice.points.at(-1).observed, true);
    assert.equal(alice.points.at(-1).totalBytes, 0);
    assert.equal(alice.lastSampleAt, '2026-09-12T14:00:00.000Z');
    const total = trafficSeries(db, '24h', null, now);
    assert.deepEqual(total.totals, { uploadBytes: 350, downloadBytes: 780, totalBytes: 1130 });
    const empty = trafficSeries(db, '24h', 'empty', now);
    assert.equal(empty.observedBuckets, 0);
    assert.equal(empty.lastSampleAt, null);
    assert.ok(empty.points.every((point) => !point.observed));
    const weekly = trafficSeries(db, '7d', 'alice', now);
    assert.equal(weekly.points.length, 7);
    assert.equal(weekly.unit, 'day');
    assert.equal(weekly.points.at(-1).totalBytes, 1000);
    assert.equal(trafficSeries(db, 'invalid', null, now).range, '24h');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
