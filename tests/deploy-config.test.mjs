import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { createSuiApi, parseMode } from '../deploy/config.mjs';
import { configureInternal, internalProfile } from '../deploy/configure-mtls-inbound.mjs';
import { configureTuic, tuicProfiles } from '../deploy/enable-tuic.mjs';
import { renderTemplate, renderTemplates, templateValues } from '../deploy/render-templates.mjs';
import { checkHealth } from '../deploy/health-check.mjs';
import { generateSecrets } from '../deploy/generate-secrets.mjs';
import { passwordPolicyError } from '../server/security.mjs';
import { loadAppConfig } from '../server/config.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const tuicEnv = {
  PROXY_SERVER_NAME: 'proxy.example.invalid', DATA_PLANE_CERT_PATH: '/fixture/tls/fullchain.pem',
  DATA_PLANE_KEY_PATH: '/fixture/tls/privkey.pem', DEVICE_CA_CERT_PATH: '/fixture/ca.crt',
  TUIC_PORT: '9443', TUIC_LISTEN_HOST: '127.0.0.1',
};

function fixtureApi(initial = {}) {
  const state = { tls: structuredClone(initial.tls || []), inbounds: structuredClone(initial.inbounds || []) };
  const writes = [];
  const requests = [];
  return {
    state, writes, requests,
    async request(path) {
      requests.push(path);
      if (path === '/tls') return structuredClone({ tls: state.tls });
      if (path === '/inbounds') return structuredClone({ inbounds: state.inbounds });
      if (path.startsWith('/inbounds?id=')) return structuredClone({ inbounds: state.inbounds.filter((item) => String(item.id) === decodeURIComponent(path.split('=')[1])) });
      throw new Error(`Unexpected request ${path}`);
    },
    async save(object, action, data) {
      assert.ok(['tls', 'inbounds'].includes(object), 'Never create tokens or accounts');
      writes.push({ object, action, data: structuredClone(data) });
      if (action === 'new') state[object].push({ ...structuredClone(data), id: state[object].length + 1 });
      else state[object] = state[object].map((item) => item.id === data.id ? structuredClone(data) : item);
    },
  };
}

test('deployment modes default to offline dry-run and reject old implicit mutation modes', () => {
  assert.equal(parseMode([]), 'dry-run');
  assert.equal(parseMode(['--apply']), 'apply');
  assert.equal(parseMode(['--status']), 'status');
  for (const args of [['prepare'], ['apply'], ['--apply', '--status'], ['--unknown']]) assert.throws(() => parseMode(args));
});

test('inbound and TUIC dry runs never call the API or require tokens', async () => {
  const api = fixtureApi();
  const internal = await configureInternal({ env: {}, api });
  const tuic = await configureTuic({ env: tuicEnv, api });
  assert.equal(internal.mode, 'dry-run');
  assert.equal(tuic.offline, true);
  assert.deepEqual(api.requests, []);
  assert.deepEqual(api.writes, []);
  assert.equal(tuic.tls.server.client_authentication, 'require-and-verify');
  assert.equal(tuic.inbound.zero_rtt_handshake, false);
});

test('internal VLESS can never be made public by helper input', () => {
  for (const host of ['0.0.0.0', '192.0.2.1', 'example.invalid']) assert.throws(() => internalProfile({ DATA_PLANE_INTERNAL_HOST: host }), /loopback/);
  assert.equal(internalProfile({ DATA_PLANE_INTERNAL_HOST: '::1' }).listen, '::1');
  for (const value of ['0', '65536', '443.5', '443oops']) assert.throws(() => internalProfile({ DATA_PLANE_INTERNAL_PORT: value }));
});

test('TUIC has no production host or certificate fallback and validates every endpoint', () => {
  assert.throws(() => tuicProfiles({}), /PROXY_SERVER_NAME/);
  for (const key of ['DATA_PLANE_CERT_PATH', 'DATA_PLANE_KEY_PATH', 'DEVICE_CA_CERT_PATH']) {
    assert.throws(() => tuicProfiles({ ...tuicEnv, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => tuicProfiles({ ...tuicEnv, TUIC_PORT: '0' }));
  assert.throws(() => tuicProfiles({ ...tuicEnv, TUIC_LISTEN_HOST: 'example.invalid' }));
  assert.throws(() => tuicProfiles({ ...tuicEnv, TUIC_CONGESTION_CONTROL: 'invalid' }));
  assert.equal(tuicProfiles({ ...tuicEnv, TUIC_LISTEN_HOST: '0.0.0.0' }).inbound.listen, '0.0.0.0');
});

test('status never saves and exposes no unrelated inbound secrets', async () => {
  const api = fixtureApi({ inbounds: [{ id: 7, type: 'vless', tag: 'cloudbridge-vless-internal', password: 'fixture-secret', listen: '127.0.0.1', listen_port: 2443 }] });
  const result = await configureInternal({ mode: 'status', env: {}, api });
  await configureTuic({ mode: 'status', env: tuicEnv, api });
  assert.deepEqual(api.writes, []);
  assert.equal(result.inbound.id, 7);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|password/);
});

test('explicit internal apply with a local fixture retains users and is idempotent', async () => {
  const api = fixtureApi({ inbounds: [{ ...internalProfile({}), id: 7, listen_port: 9999, users: [41], out_json: { retained: true }, custom: true }] });
  await configureInternal({ mode: 'apply', env: {}, api });
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.state.inbounds[0].users, [41]);
  assert.deepEqual(api.state.inbounds[0].out_json, { retained: true });
  assert.equal(api.state.inbounds[0].custom, true);
  assert.equal(api.state.inbounds[0].listen_port, 2443);
  const again = await configureInternal({ mode: 'apply', env: {}, api });
  assert.equal(again.changed, false);
  assert.equal(api.writes.length, 1);
});

test('explicit TUIC apply with a local fixture creates TLS then inbound without accounts', async () => {
  const api = fixtureApi();
  const result = await configureTuic({ mode: 'apply', env: tuicEnv, api });
  assert.deepEqual(api.writes.map(({ object }) => object), ['tls', 'inbounds']);
  assert.equal(result.tuicInboundId, 1);
  assert.equal(api.state.inbounds[0].tls_id, 1);
  await configureTuic({ mode: 'apply', env: tuicEnv, api });
  assert.equal(api.writes.length, 2, 'No second write for unchanged config');
});

test('TUIC updates preserve unrelated fields and existing inbound users', async () => {
  const profiles = tuicProfiles(tuicEnv);
  const api = fixtureApi({
    tls: [{ ...profiles.tls, id: 3, custom: true }],
    inbounds: [{ ...profiles.inbound, id: 4, tls_id: 3, listen_port: 5555, users: [12], out_json: { ...profiles.inbound.out_json, retained: true } }],
  });
  await configureTuic({ mode: 'apply', env: tuicEnv, api });
  assert.equal(api.state.tls[0].custom, true);
  assert.deepEqual(api.state.inbounds[0].users, [12]);
  assert.equal(api.state.inbounds[0].out_json.retained, true);
});

test('conflicting types and duplicate managed names fail before any save', async () => {
  const profiles = tuicProfiles(tuicEnv);
  for (const inbounds of [[{ id: 1, tag: profiles.inbound.tag, type: 'vless' }], [{ id: 1, tag: profiles.inbound.tag }, { id: 2, tag: profiles.inbound.tag }]]) {
    const api = fixtureApi({ inbounds });
    await assert.rejects(configureTuic({ mode: 'apply', env: tuicEnv, api }));
    assert.deepEqual(api.writes, []);
  }
});

test('S-UI API rejects unsafe endpoints before calling fetch', () => {
  for (const url of ['http://remote.example.invalid/app', 'ftp://127.0.0.1/app', 'https://user:pass@example.invalid/app', 'https://example.invalid/app?token=x']) {
    assert.throws(() => createSuiApi({ SUI_API_URL: url, SUI_API_TOKEN: 'local-fixture' }, () => assert.fail('No network allowed')));
  }
});

test('S-UI API refuses redirects and redacts error bodies', async () => {
  let options;
  const api = createSuiApi({ SUI_API_URL: 'http://127.0.0.1:2095/app/apiv2', SUI_API_TOKEN: 'local-fixture' }, async (_, init) => {
    options = init;
    return { ok: true, async json() { return { success: false, msg: 'secret error details' }; } };
  });
  await assert.rejects(api.request('/inbounds'), { message: 'S-UI request failed' });
  assert.equal(options.redirect, 'error');
  const badJson = createSuiApi({ SUI_API_URL: 'https://example.invalid/api', SUI_API_TOKEN: 'fixture' }, async () => ({ ok: true, async json() { throw new Error('secret body'); } }));
  await assert.rejects(badJson.request('/inbounds'), { message: 'Invalid S-UI JSON response' });
});

test('rendered templates contain operator paths, hardening and safe canonical proxy headers', async () => {
  const env = parseEnv(await read('deploy/deployment.env.example'));
  const rendered = await renderTemplates(env);
  assert.equal(Object.keys(rendered).length, 5);
  for (const content of Object.values(rendered)) assert.doesNotMatch(content, /\{\{/);
  assert.match(rendered['cloudbridge.service'], /ProtectSystem=strict/);
  assert.match(rendered['cloudbridge.service'], /WorkingDirectory=\/srv\/example\/cloudbridge\/app/);
  assert.match(rendered['s-ui.service'], /SupplementaryGroups=cloudbridge/);
  assert.match(rendered['cloudbridge-backup.service'], /backup-cloudbridge\.sh --apply/);
  assert.match(rendered['nginx-cloudbridge.conf'], /proxy_set_header Host proxy\.example\.invalid:8443;/);
  assert.match(rendered['nginx-cloudbridge.conf'], /proxy_set_header X-Forwarded-Host proxy\.example\.invalid:8443;/);
  assert.match(rendered['nginx-cloudbridge.conf'], /X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(rendered['nginx-cloudbridge.conf'], /\$proxy_add_x_forwarded_for|\$host:\$server_port/);
});

test('nginx HTTPS 443 authority omits default port; 8443 keeps it', async () => {
  const env = parseEnv(await read('deploy/deployment.env.example'));
  const normal = templateValues(env);
  const standard = templateValues({ ...env, CONSOLE_TLS_PORT: '443', DATA_PLANE_PORT: '9443' });
  assert.equal(normal.CONSOLE_AUTHORITY, 'proxy.example.invalid:8443');
  assert.equal(standard.CONSOLE_AUTHORITY, 'proxy.example.invalid');
  const template = await read('deploy/nginx-cloudbridge.conf');
  const rendered = renderTemplate(template, standard);
  assert.match(rendered, /proxy_set_header Host proxy\.example\.invalid;/);
  assert.match(rendered, /return 301 https:\/\/proxy\.example\.invalid\$request_uri;/);
  assert.equal(new URL(`https://${standard.CONSOLE_AUTHORITY}`).host, standard.CONSOLE_AUTHORITY);
  assert.equal(new URL(`https://${normal.CONSOLE_AUTHORITY}`).host, normal.CONSOLE_AUTHORITY);
});

test('template rendering rejects configuration injection and unsafe upstreams', async () => {
  const env = parseEnv(await read('deploy/deployment.env.example'));
  for (const overrides of [{ CB_APP_DIR: '/srv/app\nExecStart=/bad' }, { CB_APP_DIR: '/srv/../etc' }, { CB_USER: 'root;bad' }, { PUBLIC_HOST: 'example.invalid; bad' }, { HOST: '0.0.0.0' }, { CONSOLE_TLS_PORT: '443' }]) {
    assert.throws(() => templateValues({ ...env, ...overrides }));
  }
  assert.throws(() => renderTemplate('{{MISSING}}', {}), /Missing template/);
});

test('health response validation is read-only and uses only injected fixtures', async () => {
  const calls = [];
  const checks = await checkHealth({ HEALTH_CONSOLE_URL: 'http://127.0.0.1:8787/api/bootstrap' }, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { setupRequired: true, productName: 'Fixture' }; } };
  });
  assert.deepEqual(checks, ['CONSOLE_API_OK']);
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(checkHealth({ HEALTH_CONSOLE_URL: 'http://remote.example.invalid/api/bootstrap' }, () => assert.fail('Must not fetch')), /HTTPS/);
});

test('secret generator creates valid local application secrets, never S-UI credentials', () => {
  const secrets = generateSecrets();
  assert.equal(passwordPolicyError(secrets.adminPassword), '');
  assert.equal(Buffer.from(secrets.encryptionKey, 'base64').length, 32);
  assert.deepEqual(Object.keys(secrets).sort(), ['adminPassword', 'adminUsername', 'encryptionKey', 'setupToken']);
});

test('shell helpers parse correctly and default to no-network, no-write plans', async () => {
  // A clean environment prevents ambient service credentials/config from entering even these dry runs.
  const env = { PATH: '/usr/bin:/bin' };
  for (const file of ['backup-cloudbridge.sh', 'certbot-reload-cloudbridge.sh', 'health-check.sh', 'shell-common.sh']) {
    execFileSync('bash', ['-n', `deploy/${file}`], { env });
    if (file === 'shell-common.sh') continue;
    const output = execFileSync('bash', [`deploy/${file}`], { env, encoding: 'utf8' });
    assert.match(output, /DRY RUN/);
  }
  assert.match(execFileSync(process.execPath, ['deploy/generate-secrets.mjs'], { env, encoding: 'utf8' }), /DRY RUN/);
});

test('deployment source parameterizes hosts and contains no firewall/SSH automation', async () => {
  for (const file of await readdir(new URL('../deploy/', import.meta.url))) {
    const source = await read(`deploy/${file}`);
    assert.doesNotMatch(source, /firewall-cmd|iptables|ufw\s|\bssh\s/, file);
  }
  assert.match(await read('deploy/nginx-cloudbridge.conf'), /server_name \{\{PUBLIC_HOST\}\};/);
});


test('internal apply refuses success when the API silently ignores an edit', async () => {
  const api = fixtureApi({ inbounds: [{ ...internalProfile({}), id: 1, listen: '0.0.0.0' }] });
  api.save = async () => {}; // Deliberately non-conforming local API fixture.
  await assert.rejects(configureInternal({ mode: 'apply', env: {}, api }), /operator inspection, no automatic retry/);
});

test('TUIC verifies effective client-auth and TLS binding rather than merely object IDs', async () => {
  const desired = tuicProfiles(tuicEnv);
  const unsafeTls = { ...desired.tls, id: 1, server: { ...desired.tls.server, client_authentication: 'none' } };
  const api = fixtureApi({ tls: [unsafeTls], inbounds: [{ ...desired.inbound, id: 2, tls_id: 1 }] });
  api.save = async () => {};
  await assert.rejects(configureTuic({ mode: 'apply', env: tuicEnv, api }), /operator inspection, no automatic retry/);
  const mismatched = fixtureApi({ tls: [{ ...desired.tls, id: 1 }], inbounds: [{ ...desired.inbound, id: 2, tls_id: 99 }] });
  mismatched.save = async () => {};
  await assert.rejects(configureTuic({ mode: 'apply', env: tuicEnv, api: mismatched }), /operator inspection, no automatic retry/);
});

test('renewal certificate validator separately rejects a wrong hostname without installing anything', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudbridge-renewal-test-'));
  try {
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.example.invalid', '-addext', 'subjectAltName=DNS:fixture.example.invalid', '-keyout', key, '-out', cert], { stdio: 'pipe' });
    const command = 'source deploy/shell-common.sh; validate_server_certificate "$1" "$2"';
    execFileSync('bash', ['-c', command, 'fixture', cert, 'fixture.example.invalid'], { stdio: 'pipe' });
    assert.throws(() => execFileSync('bash', ['-c', command, 'fixture', cert, 'wrong.example.invalid'], { stdio: 'pipe' }));
    assert.match(await read('deploy/certbot-reload-cloudbridge.sh'), /validate_server_certificate "\$certificate" "\$PROXY_SERVER_NAME"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('application environment example passes strict server configuration without usable credentials', async () => {
  const env = parseEnv(await read('.env.example'));
  const config = loadAppConfig({}, env);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.dataPlaneHost, '127.0.0.1');
  assert.equal(config.sui.baseUrl, '');
  assert.equal(config.sui.token, '');
  assert.equal(config.encryptionKey, '');
  assert.equal(config.initialAdminPassword, '');
  assert.equal(config.tuicEnabled, false);
  assert.equal(config.clientUpdateVersion, '');
});
