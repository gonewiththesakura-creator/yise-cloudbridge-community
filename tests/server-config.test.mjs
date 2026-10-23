import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppConfig } from '../server/config.mjs';
import { createLoginLimiter } from '../server/login-limiter.mjs';
import { effectiveStatus, memberPayload } from '../server/member-policy.mjs';
import { compareVersions, validateUpdatePolicy } from '../server/update-policy.mjs';

const key = Buffer.alloc(32, 7).toString('base64');

test('configuration defaults are local and explicit overrides beat an isolated environment', () => {
  const defaults = loadAppConfig({}, {});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.dataPlaneHost, '127.0.0.1');
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.sui.baseUrl, '');
  assert.equal(defaults.encryptionKey, '');
  const environment = { PORT: '9000', SESSION_DAYS: '10', COOKIE_SECURE: 'true', TRUST_PROXY: 'true', CREDENTIAL_ENCRYPTION_KEY: key };
  const config = loadAppConfig({ port: 9001, cookieSecure: false, trustProxy: false }, environment);
  assert.equal(config.port, 9001);
  assert.equal(config.sessionDays, 10);
  assert.equal(config.cookieSecure, false);
  assert.equal(config.trustProxy, false);
  assert.equal(config.encryptionKey, key);
  environment.PORT = '9002';
  assert.equal(config.port, 9001);
});

test('configuration rejects invalid numbers, booleans, secrets and incomplete integrations without exposing secrets', () => {
  for (const [name, value] of [
    ['PORT', 'NaN'], ['PORT', '65536'], ['SESSION_DAYS', '0'], ['CREDENTIAL_HOURS', '1.5'],
    ['TRUST_PROXY', 'yes'], ['TUIC_ENABLED', '1'], ['DATA_PLANE_PORT', '-1'],
    ['CREDENTIAL_ENCRYPTION_KEY', 'not-a-secret-to-print'],
    ['CREDENTIAL_ENCRYPTION_KEY', `${key}junk`],
  ]) {
    assert.throws(() => loadAppConfig({}, { [name]: value }), (error) => {
      assert.ok(error.message.includes(name));
      if (name === 'CREDENTIAL_ENCRYPTION_KEY') assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.throws(() => loadAppConfig({}, { SUI_API_URL: 'http://127.0.0.1:2095' }), /configured together/);
  assert.throws(() => loadAppConfig({}, { DEVICE_CA_CERT_PATH: '/temporary/ca.crt' }), /configured together/);
  assert.throws(() => loadAppConfig({}, { DATA_PLANE_CERT_PATH: '/temporary/server.crt' }), /configured together/);
  assert.throws(() => loadAppConfig({}, { INITIAL_ADMIN_PASSWORD: 'short' }), /INITIAL_ADMIN_PASSWORD/);
});

test('login throttling expires, can be cleared and is instance-local', () => {
  let now = 1_000;
  const first = createLoginLimiter(() => now);
  const second = createLoginLimiter(() => now);
  for (let index = 0; index < 8; index += 1) first.recordLoginFailure('loopback');
  assert.equal(first.loginAllowed('loopback'), false);
  assert.equal(second.loginAllowed('loopback'), true);
  now += 15 * 60_000;
  assert.equal(first.loginAllowed('loopback'), true);
  for (let index = 0; index < 8; index += 1) first.recordLoginFailure('loopback');
  first.clearLoginFailures('loopback');
  assert.equal(first.loginAllowed('loopback'), true);
});

test('one member policy preserves status precedence and exact quota/expiry boundaries', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  const member = { status: 'active', expires_at: new Date(now + 1).toISOString(), traffic_quota_bytes: 100, traffic_used_bytes: 99 };
  assert.equal(effectiveStatus(member, now), 'active');
  assert.equal(effectiveStatus({ ...member, traffic_used_bytes: 100 }, now), 'quota_exceeded');
  assert.equal(effectiveStatus({ ...member, traffic_used_bytes: 100, traffic_quota_bytes: 0 }, now), 'active');
  assert.equal(effectiveStatus({ ...member, expires_at: new Date(now).toISOString(), traffic_used_bytes: 100 }, now), 'expired');
  assert.equal(effectiveStatus({ ...member, status: 'revoked', expires_at: new Date(now).toISOString() }, now), 'revoked');
  assert.throws(() => memberPayload({ name: 'A', expiresAt: 'invalid' }), { status: 400 });
});

test('client update policy compares versions numerically and validates rollout inputs', () => {
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0);
  assert.equal(compareVersions('bad', '2.0.0'), null);
  const policy = { latestVersion: '2.6.0', minimumVersion: '2.5.0', downloadUrl: 'https://example.test/app.zip', sha256: 'a'.repeat(64), fileSize: 100, releaseNotes: '' };
  assert.equal(validateUpdatePolicy({ ...policy, enabled: true }, {}).platform, 'windows-x64');
  for (const change of [{ minimumVersion: '2.7.0' }, { latestVersion: 'bad' }, { downloadUrl: 'http://example.test/app.zip' }, { sha256: 'bad' }]) {
    assert.throws(() => validateUpdatePolicy({ ...policy, ...change }, {}), { status: 400 });
  }
});

test('S-UI configuration permits loopback HTTP or remote HTTPS but no ambiguous URL components', () => {
  const environment = { SUI_API_TOKEN: 'temporary-config-test-token', SUI_VLESS_INBOUND_ID: '1' };
  for (const url of ['http://127.0.0.1:2095/app/apiv2', 'http://[::1]:2095/app/apiv2', 'http://localhost:2095/app/apiv2', 'https://sui.example.test/app/apiv2']) {
    assert.equal(loadAppConfig({}, { ...environment, SUI_API_URL: url }).sui.baseUrl, url);
  }
  for (const url of ['http://sui.example.test/app/apiv2', 'http://192.0.2.1/app/apiv2', 'http://localhost.example.test/app/apiv2']) {
    assert.throws(() => loadAppConfig({}, { ...environment, SUI_API_URL: url }), /requires HTTPS/);
  }
  for (const url of ['https://user:password@sui.example.test/app/apiv2', 'https://sui.example.test/app/apiv2?token=secret', 'https://sui.example.test/app/apiv2#fragment', 'ftp://sui.example.test/app/apiv2']) {
    assert.throws(() => loadAppConfig({}, { ...environment, SUI_API_URL: url }), /without credentials, a query, or a fragment/);
  }
});
