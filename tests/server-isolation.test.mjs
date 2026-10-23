import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFriendLinkApp } from '../server/app.mjs';

const password = 'A-secure-password-2026!';

async function start(t, overrides = {}, environment = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cloudbridge-isolation-'));
  let app;
  t.after(async () => {
    if (app) {
      await new Promise((resolve) => app.server.close(resolve));
      app.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  app = createFriendLinkApp({
    disableWorker: true, disableDataPlane: true, adapter: null, certificateIssuer: null,
    initialAdminPassword: password, ...overrides, dataDir,
  }, environment);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, headers = {}, method = 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, body: await response.json() };
  };
  return { app, request };
}

async function login(context) {
  const result = await context.request('/api/login', { username: 'admin', password });
  assert.equal(result.response.status, 200);
  return { cookie: result.response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': result.body.csrfToken };
}

test('an app login lockout never contaminates another live app or its database', async (t) => {
  const first = await start(t);
  const second = await start(t);
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await first.request('/api/login', { username: 'missing', password: 'wrong' })).response.status, 401);
  }
  assert.equal((await first.request('/api/login', { username: 'admin', password })).response.status, 429);
  const headers = await login(second);
  assert.equal((await second.request('/api/members', { name: 'Only second', durationDays: 3 }, headers)).response.status, 201);
  assert.equal(first.app.db.prepare('SELECT COUNT(*) AS count FROM members').get().count, 0);
  assert.equal(second.app.db.prepare('SELECT COUNT(*) AS count FROM members').get().count, 1);
});

test('adapter token and integration disabling are explicit per-app configuration snapshots', async (t) => {
  const environment = {
    PROXY_ADAPTER_TOKEN: 'temporary-adapter-token-A',
    SUI_API_URL: 'http://127.0.0.1:1/never-contact', SUI_API_TOKEN: 'temporary-test-only', SUI_VLESS_INBOUND_ID: '1',
  };
  const first = await start(t, {}, environment);
  const second = await start(t, { proxyAdapterToken: 'temporary-adapter-token-B' });
  assert.equal(first.app.options.adapter, null);
  environment.PROXY_ADAPTER_TOKEN = 'mutated-after-construction';
  for (const [context, accepted, rejected] of [
    [first, 'temporary-adapter-token-A', 'temporary-adapter-token-B'],
    [second, 'temporary-adapter-token-B', 'temporary-adapter-token-A'],
  ]) {
    assert.equal((await context.request('/api/adapter/usage', { records: [] }, { authorization: `Bearer ${accepted}` })).response.status, 202);
    assert.equal((await context.request('/api/adapter/usage', { records: [] }, { authorization: `Bearer ${rejected}` })).response.status, 401);
    assert.equal((await context.request('/api/adapter/usage', { records: [] }, { authorization: 'Bearer mutated-after-construction' })).response.status, 401);
  }
});

test('publishing an update with PUT requires CSRF and only changes the intended app', async (t) => {
  const first = await start(t);
  const second = await start(t);
  const headers = await login(first);
  const policy = { enabled: true, latestVersion: '2.6.0', minimumVersion: '2.5.0', downloadUrl: 'https://example.test/app.zip', sha256: 'a'.repeat(64) };
  for (const csrf of [undefined, 'wrong-token']) {
    const sentHeaders = { cookie: headers.cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) };
    assert.equal((await first.request('/api/client-update', policy, sentHeaders, 'PUT')).response.status, 403);
    assert.equal(first.app.db.prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 0);
  }
  assert.equal((await first.request('/api/client-update', policy, headers, 'PUT')).response.status, 200);
  assert.equal((await first.request('/api/client/update?version=2.4.0', undefined, {}, 'GET')).body.required, true);
  assert.equal((await second.request('/api/client/update?version=2.4.0', undefined, {}, 'GET')).body.available, false);
});

test('non-object JSON input fails with a client error without breaking subsequent requests', async (t) => {
  const context = await start(t);
  for (const body of [null, [], 'string', 1, true]) {
    assert.equal((await context.request('/api/login', body)).response.status, 400);
  }
  assert.equal((await context.request('/api/bootstrap', undefined, {}, 'GET')).response.status, 200);
  await login(context);
});
