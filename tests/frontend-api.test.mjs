import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from '../src/api-client.mjs';
import { formatBytes, bytesToGb, gbToBytes } from '../src/formatters.mjs';

const ok = (payload = { ok: true }) => new Response(JSON.stringify(payload), { status: 200 });

test('console requests keep same-origin credentials and send CSRF on PUT', async () => {
  let observed;
  const api = createApiClient(async (...args) => { observed = args; return ok(); });
  api.setCsrfToken('isolated-test-session');
  assert.deepEqual(await api('/api/client-update', { method: 'PUT', body: '{}', redirect: 'follow', headers: { accept: 'application/json' } }), { ok: true });
  assert.equal(observed[0], '/api/client-update');
  assert.equal(observed[1].method, 'PUT');
  assert.equal(observed[1].credentials, 'same-origin');
  assert.equal(observed[1].redirect, 'error');
  assert.equal(observed[1].headers.get('x-csrf-token'), 'isolated-test-session');
  assert.equal(observed[1].headers.get('content-type'), 'application/json');
  assert.equal(observed[1].headers.get('accept'), 'application/json');
});

test('console session state is isolated and explicitly cleared on logout', async () => {
  const seen = [];
  const fetch = async (_path, options) => { seen.push(options.headers.get('x-csrf-token')); return ok(); };
  const first = createApiClient(fetch);
  const second = createApiClient(fetch);
  first.setCsrfToken('first-session');
  await first('/api/me');
  await second('/api/me');
  first.clearSession();
  await first('/api/me');
  assert.deepEqual(seen, ['first-session', null, null]);
});

test('console transport rejects off-origin targets without making requests', async () => {
  let calls = 0;
  const api = createApiClient(async () => { calls++; return ok(); });
  for (const path of ['https://example.test/api/me', '//example.test/api/me', '/api\\example.test', '/settings', null]) {
    await assert.rejects(api(path), /same-origin/);
  }
  assert.equal(calls, 0);
});

test('console errors preserve API messages and handle non-JSON failures', async () => {
  const denied = createApiClient(async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403 }));
  await assert.rejects(denied('/api/me'), /denied/);
  const unavailable = createApiClient(async () => new Response('<html>unavailable</html>', { status: 503 }));
  await assert.rejects(unavailable('/api/me'), /503/);
  const cancelled = createApiClient(async () => { throw new DOMException('cancelled', 'AbortError'); });
  await assert.rejects(cancelled('/api/me'), { name: 'AbortError' });
});

test('quota formatting preserves existing byte/GB conversions', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(bytesToGb(1.5 * 1024 ** 3), 1.5);
  assert.equal(gbToBytes('1.5'), 1.5 * 1024 ** 3);
  for (const value of [-1, 'bad', '', Infinity]) assert.equal(gbToBytes(value), 0);
});
