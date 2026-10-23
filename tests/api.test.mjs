import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFriendLinkApp } from '../server/app.mjs';
import { SuiAdapter } from '../server/proxy-adapter.mjs';
import { recordTrafficTotals } from '../server/traffic-usage.mjs';

const TEST_PASSWORD = 'A-secure-password-2026!';

test('traffic API requires admin login and filters by an existing member', async () => {
  const context = await startTestApp();
  try {
    assert.equal((await fetch(`${context.baseUrl}/api/traffic?memberId=alice`)).status, 401);
    await fetch(`${context.baseUrl}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const login = await fetch(`${context.baseUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    const now = new Date().toISOString();
    for (const id of ['alice', 'bob']) {
      context.app.db.prepare('INSERT INTO members(id, name, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, '2030-01-01T00:00:00Z', now, now);
      recordTrafficTotals(context.app.db, id, 0, 0);
    }
    recordTrafficTotals(context.app.db, 'alice', 30, 70);
    recordTrafficTotals(context.app.db, 'bob', 500, 900);
    const one = await fetch(`${context.baseUrl}/api/traffic?range=24h&memberId=alice`, { headers });
    assert.equal(one.status, 200);
    assert.deepEqual((await one.json()).totals, { uploadBytes: 30, downloadBytes: 70, totalBytes: 100 });
    const all = await fetch(`${context.baseUrl}/api/traffic?range=24h`, { headers });
    assert.equal((await all.json()).totals.totalBytes, 1500);
    assert.equal((await fetch(`${context.baseUrl}/api/traffic?memberId=missing`, { headers })).status, 404);
    assert.equal((await fetch(`${context.baseUrl}/api/traffic?memberId=%27%20OR%201%3D1--`, { headers })).status, 404);
  } finally { await context.stop(); }
});

async function startTestApp(overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'friendlink-test-'));
  let certificateNumber = 0;
  const certificateIssuer = async ({ deviceId }) => ({
    certificatePem: `TEST-CERTIFICATE:${deviceId}`,
    fingerprintSha256: (++certificateNumber).toString(16).padStart(64, '0'),
    serialNumber: certificateNumber.toString(16).padStart(2, '0'),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const app = createFriendLinkApp({
    dataDir,
    disableWorker: true,
    disableDataPlane: true,
    productName: 'TestLink',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    certificateIssuer,
    ...overrides,
    dataDir,
  }, {});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return {
    app,
    dataDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      app.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('admin can manage a member lifecycle', async () => {
  const context = await startTestApp();
  let cookie = '';
  let csrf = '';
  const request = async (path, options = {}) => {
    const response = await fetch(`${context.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await response.json();
    return { response, body };
  };

  try {
    const bootstrap = await request('/api/bootstrap');
    assert.equal(bootstrap.body.setupRequired, true);
    assert.equal(bootstrap.body.productName, 'TestLink');

    const setup = await request('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    assert.equal(setup.response.status, 201);

    const login = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    assert.equal(login.response.status, 200);
    csrf = login.body.csrfToken;
    assert.equal(login.body.username, 'admin');

    const created = await request('/api/members', {
      method: 'POST',
      body: JSON.stringify({
        name: '小林', durationDays: 30, trafficQuotaBytes: 100 * 1024 ** 3,
        maxConnections: 2,
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.member.name, '小林');
    const memberId = created.body.member.id;

    const extended = await request(`/api/members/${memberId}/extend`, {
      method: 'POST', body: JSON.stringify({ days: 30 }),
    });
    assert.equal(extended.response.status, 200);
    assert.equal(extended.body.member.status, 'active');

    const suspended = await request(`/api/members/${memberId}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'suspended' }),
    });
    assert.equal(suspended.body.member.status, 'suspended');

    const code = await request(`/api/members/${memberId}/activation-code`, {
      method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    assert.equal(code.response.status, 201);
    assert.match(code.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const dashboard = await request('/api/dashboard');
    assert.equal(dashboard.body.summary.total, 1);
    assert.equal(dashboard.body.members[0].status, 'suspended');

    const revoked = await request(`/api/members/${memberId}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'revoked' }),
    });
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body.member.configuredStatus, 'revoked');
    const deleted = await request(`/api/members/${memberId}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    const afterDelete = await request('/api/dashboard');
    assert.equal(afterDelete.body.summary.total, 0);
  } finally {
    await context.stop();
  }
});

test('2.4 client receives device-bound TUIC credentials without breaking v1 renewals', async () => {
  const context = await startTestApp({ tuicEnabled: true, tuicPort: 443 });
  let cookie = '';
  let csrf = '';
  const request = async (path, options = {}) => {
    const response = await fetch(`${context.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.json() };
  };

  try {
    await request('/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    csrf = login.body.csrfToken;
    const created = await request('/api/members', {
      method: 'POST', body: JSON.stringify({ name: '双协议测试', durationDays: 30, trafficQuotaBytes: 1024 ** 3 }),
    });
    const code = await request(`/api/members/${created.body.member.id}/activation-code`, {
      method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    cookie = '';
    csrf = '';

    const deviceKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const transportKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const devicePublicKey = deviceKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const transportPublicKey = transportKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const fingerprintHash = 'd'.repeat(64);
    const enrolled = await request('/api/device/register', {
      method: 'POST',
      body: JSON.stringify({
        activationCode: code.body.code, deviceName: '2.4 PC', fingerprintHash,
        publicKey: devicePublicKey, keyProvider: 'test', clientVersion: '2.4.0',
      }),
    });
    const transportHash = (await import('node:crypto')).createHash('sha256').update(transportPublicKey).digest('hex');
    const message = `cloudbridge:v2:renew:${enrolled.body.deviceId}:${enrolled.body.nonce}:${fingerprintHash}:${transportHash}`;
    const signature = sign('sha256', Buffer.from(message), {
      key: deviceKeys.privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    const renewed = await request('/api/device/renew', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: enrolled.body.deviceId, nonce: enrolled.body.nonce, fingerprintHash,
        signature, transportPublicKey, clientVersion: '2.4.0',
      }),
    });
    assert.equal(renewed.response.status, 200);
    assert.match(renewed.body.protocols.vless.uuid, /^[0-9a-f-]{36}$/);
    assert.match(renewed.body.protocols.tuic.uuid, /^[0-9a-f-]{36}$/);
    assert.ok(renewed.body.protocols.tuic.password.length >= 32);
    assert.equal(renewed.body.protocols.tuic.serverPort, 443);
    assert.match(renewed.body.transportCertificatePem, /^TEST-CERTIFICATE:/);
    assert.equal(context.app.db.prepare('SELECT COUNT(*) AS count FROM device_certificates').get().count, 2);

    let savedClient;
    let clientsCall = 0;
    const adapter = new SuiAdapter({
      baseUrl: 'http://127.0.0.1:1', token: 'test', vlessInboundId: 7, tuicInboundId: 8,
    });
    adapter.clients = async () => {
      clientsCall += 1;
      return clientsCall === 1 || !savedClient ? [] : [{ id: 99, name: savedClient.name, desc: created.body.member.id }];
    };
    adapter.saveClient = async (action, data) => { assert.equal(action, 'new'); savedClient = data; };
    await adapter.syncMember(context.app.db, created.body.member.id, Buffer.alloc(32, 7).toString('base64'));
    assert.deepEqual(savedClient.inbounds, [7, 8]);
    assert.equal(savedClient.config.vless.uuid, renewed.body.protocols.vless.uuid);
    assert.equal(savedClient.config.tuic.uuid, renewed.body.protocols.tuic.uuid);
    assert.equal(savedClient.config.tuic.password, renewed.body.protocols.tuic.password);
  } finally {
    await context.stop();
  }
});

test('admin can publish a mandatory Windows client update policy', async () => {
  const context = await startTestApp();
  let cookie = '';
  let csrf = '';
  const request = async (path, options = {}) => {
    const response = await fetch(`${context.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.json() };
  };

  try {
    const unavailable = await request('/api/client/update?platform=windows-x64&version=2.2.1');
    assert.equal(unavailable.response.status, 200);
    assert.equal(unavailable.body.available, false);

    await request('/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    csrf = login.body.csrfToken;
    const published = await request('/api/client-update', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        latestVersion: '2.3.0',
        minimumVersion: '2.3.0',
        downloadUrl: 'https://downloads.example.test/YiseCloudBridge-Windows-x64-2.3.0.zip',
        sha256: 'a'.repeat(64),
        fileSize: 81_000_000,
        releaseNotes: '安全自动更新',
      }),
    });
    assert.equal(published.response.status, 200);
    assert.equal(published.body.policy.latestVersion, '2.3.0');

    cookie = '';
    csrf = '';
    const required = await request('/api/client/update?platform=windows-x64&version=2.2.1');
    assert.equal(required.body.updateAvailable, true);
    assert.equal(required.body.required, true);
    const current = await request('/api/client/update?platform=windows-x64&version=2.3.0');
    assert.equal(current.body.updateAvailable, false);
    assert.equal(current.body.required, false);

    const outdatedEnrollment = await request('/api/device/register', {
      method: 'POST',
      body: JSON.stringify({ clientVersion: '2.2.9' }),
    });
    assert.equal(outdatedEnrollment.response.status, 426);
    assert.match(outdatedEnrollment.body.error, /客户端版本过低/);
  } finally {
    await context.stop();
  }
});

test('device enrollment binds signed credentials to one hardware fingerprint', async () => {
  const context = await startTestApp();
  let cookie = '';
  let csrf = '';
  const request = async (path, options = {}) => {
    const response = await fetch(`${context.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.json() };
  };

  try {
    await request('/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    csrf = login.body.csrfToken;
    const created = await request('/api/members', {
      method: 'POST', body: JSON.stringify({ name: '设备测试', durationDays: 30, trafficQuotaBytes: 1024 ** 3 }),
    });
    const code = await request(`/api/members/${created.body.member.id}/activation-code`, {
      method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    cookie = '';
    csrf = '';
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const fingerprintHash = 'a'.repeat(64);
    const enrolled = await request('/api/device/register', {
      method: 'POST',
      body: JSON.stringify({
        activationCode: code.body.code,
        deviceName: 'Test PC',
        fingerprintHash,
        publicKey,
        keyProvider: 'test',
      }),
    });
    assert.equal(enrolled.response.status, 201);
    const message = `cloudbridge:v1:renew:${enrolled.body.deviceId}:${enrolled.body.nonce}:${fingerprintHash}`;
    const signature = sign('sha256', Buffer.from(message), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    const renewed = await request('/api/device/renew', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: enrolled.body.deviceId,
        nonce: enrolled.body.nonce,
        fingerprintHash,
        signature,
      }),
    });
    assert.equal(renewed.response.status, 200);
    assert.match(renewed.body.protocols.vless.uuid, /^[0-9a-f-]{36}$/);
    assert.equal(renewed.body.server.port, 443);
    assert.match(renewed.body.deviceCertificatePem, /^TEST-CERTIFICATE:/);

    const challenge = await request('/api/device/challenge', {
      method: 'POST', body: JSON.stringify({ deviceId: enrolled.body.deviceId }),
    });
    const copiedFingerprint = 'b'.repeat(64);
    const copiedMessage = `cloudbridge:v1:renew:${enrolled.body.deviceId}:${challenge.body.nonce}:${copiedFingerprint}`;
    const copiedSignature = sign('sha256', Buffer.from(copiedMessage), {
      key: keys.privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    const rejected = await request('/api/device/renew', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: enrolled.body.deviceId,
        nonce: challenge.body.nonce,
        fingerprintHash: copiedFingerprint,
        signature: copiedSignature,
      }),
    });
    assert.equal(rejected.response.status, 403);
    assert.match(rejected.body.error, /指纹/);
  } finally {
    await context.stop();
  }
});

test('an unbound device can register again with a fresh activation code', async () => {
  const context = await startTestApp();
  let cookie = '';
  let csrf = '';
  const request = async (path, options = {}) => {
    const response = await fetch(`${context.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.json() };
  };

  try {
    await request('/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    csrf = login.body.csrfToken;
    const created = await request('/api/members', {
      method: 'POST', body: JSON.stringify({ name: '重新绑定测试', durationDays: 30, trafficQuotaBytes: 1024 ** 3 }),
    });
    const memberId = created.body.member.id;
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const registration = {
      deviceName: 'Same Test PC',
      fingerprintHash: 'd'.repeat(64),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      keyProvider: 'test',
    };

    const firstCode = await request(`/api/members/${memberId}/activation-code`, {
      method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    cookie = '';
    csrf = '';
    const firstEnrollment = await request('/api/device/register', {
      method: 'POST', body: JSON.stringify({ ...registration, activationCode: firstCode.body.code }),
    });
    assert.equal(firstEnrollment.response.status, 201);

    const relogin = await request('/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    csrf = relogin.body.csrfToken;
    const reset = await request(`/api/members/${memberId}/reset-device`, {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.body.member.device, null);
    const secondCode = await request(`/api/members/${memberId}/activation-code`, {
      method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }),
    });

    cookie = '';
    csrf = '';
    const secondEnrollment = await request('/api/device/register', {
      method: 'POST', body: JSON.stringify({ ...registration, activationCode: secondCode.body.code }),
    });
    assert.equal(secondEnrollment.response.status, 201);
    assert.notEqual(secondEnrollment.body.deviceId, firstEnrollment.body.deviceId);
  } finally {
    await context.stop();
  }
});

test('mutations require a valid csrf token', async () => {
  const context = await startTestApp();
  try {
    await fetch(`${context.baseUrl}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    const login = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const loginBody = await login.json();
    const response = await fetch(`${context.baseUrl}/api/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '无令牌请求', durationDays: 30 }),
    });
    assert.equal(response.status, 403);
  } finally {
    await context.stop();
  }
});

test('password-only login supports password rotation and enforces complexity', async () => {
  const context = await startTestApp();
  try {
    const weakSetup = await fetch(`${context.baseUrl}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'short' }),
    });
    assert.equal(weakSetup.status, 400);
    await fetch(`${context.baseUrl}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    const login = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    const session = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal(login.status, 200);
    const newPassword = 'New-complex-password-2026!';
    const changed = await fetch(`${context.baseUrl}/api/account/password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword }),
    });
    assert.equal(changed.status, 403);
    const changedWithSession = await fetch(`${context.baseUrl}/api/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword }),
    });
    assert.equal(changedWithSession.status, 200);
    const oldLogin = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }),
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: newPassword }),
    });
    assert.equal(newLogin.status, 200);
  } finally {
    await context.stop();
  }
});
