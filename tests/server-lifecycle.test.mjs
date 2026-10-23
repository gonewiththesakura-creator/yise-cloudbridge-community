import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { createFriendLinkApp } from '../server/app.mjs';

const password = 'A-secure-password-2026!';
const windowsOpenSsl = join(process.env.LOCALAPPDATA || '', 'hermes', 'git', 'usr', 'bin', 'openssl.exe');
const openssl = process.platform === 'win32' && existsSync(windowsOpenSsl) ? windowsOpenSsl : 'openssl';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function createTestCertificates(workspace) {
  const run = (args) => execFileSync(openssl, args, { cwd: workspace, stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  for (const name of ['ca', 'server']) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(join(workspace, `${name}.key`), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  run(['req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=CloudBridge Ephemeral Lifecycle CA', '-days', '1', '-out', 'ca.crt']);
  run(['req', '-new', '-key', 'server.key', '-subj', '/CN=localhost', '-out', 'server.csr']);
  writeFileSync(join(workspace, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '1', '-days', '1', '-sha256', '-extfile', 'server.ext', '-out', 'server.crt']);
}

function waitClosed(socket, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session did not close within the revalidation window')), timeout);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.on('error', () => {});
  });
}

function deniedTls(options) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => socket.write('must-not-be-forwarded'));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('revoked TLS connection remained open'));
    }, 3_000);
    socket.on('error', () => {});
    socket.once('data', () => reject(new Error('revoked TLS connection forwarded data')));
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

// Offline integration: actual HTTP routes, SQLite, ECDSA verification, OpenSSL
// certificate issuance and TLS forwarding. No fake issuer, S-UI or external calls.
test('HTTP activation → signed renewals → real mTLS → administrative revocation denies renewal and live/new tunnels', { timeout: 20_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cloudbridge-lifecycle-'));
  const upstreamSockets = new Set();
  let app;
  let upstream;
  let client;
  try {
    createTestCertificates(workspace);
    upstream = net.createServer((socket) => {
      upstreamSockets.add(socket);
      socket.once('close', () => upstreamSockets.delete(socket));
      socket.pipe(socket);
    });
    const upstreamPort = await listen(upstream);
    app = createFriendLinkApp({
      dataDir: workspace, disableWorker: true, adapter: null,
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
      deviceCaCertificatePath: join(workspace, 'ca.crt'),
      deviceCaPrivateKeyPath: join(workspace, 'ca.key'),
      dataPlaneCertificatePath: join(workspace, 'server.crt'),
      dataPlanePrivateKeyPath: join(workspace, 'server.key'),
      dataPlaneInternalPort: upstreamPort, opensslPath: openssl,
    }, {});
    const apiPort = await listen(app.server);
    const gatewayPort = await listen(app.dataPlane.server);
    const base = `http://127.0.0.1:${apiPort}`;
    const request = async (path, body, headers = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    assert.equal((await request('/api/setup', { username: 'admin', password })).status, 201);
    const login = await request('/api/login', { username: 'admin', password });
    assert.equal(login.status, 200);
    const admin = { cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': login.body.csrfToken };
    const created = await request('/api/members', { name: 'Offline lifecycle', durationDays: 2, trafficQuotaBytes: 1_000_000 }, admin);
    assert.equal(created.status, 201);
    const memberId = created.body.member.id;
    const activation = await request(`/api/members/${memberId}/activation-code`, {}, admin);
    assert.equal(activation.status, 201);
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const transport = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = device.publicKey.export({ type: 'spki', format: 'pem' });
    const transportPublicKey = transport.publicKey.export({ type: 'spki', format: 'pem' });
    const fingerprintHash = 'e'.repeat(64);
    const registration = { activationCode: activation.body.code, deviceName: 'Ephemeral test device', keyProvider: 'test-memory', publicKey, fingerprintHash, clientVersion: '2.6.0' };
    const enrolled = await request('/api/device/register', registration);
    assert.equal(enrolled.status, 201);
    assert.equal((await request('/api/device/register', registration)).status, 400, 'activation is single-use');
    const deviceId = enrolled.body.deviceId;
    const signed = (nonce, key = device.privateKey) => {
      // Independently construct the documented client protocol, not the server helper.
      const hash = createHash('sha256').update(transportPublicKey).digest('hex');
      const message = `cloudbridge:v2:renew:${deviceId}:${nonce}:${fingerprintHash}:${hash}`;
      return { deviceId, nonce, fingerprintHash, clientVersion: '2.6.0', transportPublicKey,
        signature: sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64') };
    };
    assert.equal((await request('/api/device/renew', signed(enrolled.body.nonce, transport.privateKey))).status, 403, 'another private key cannot renew');
    const renewalBody = signed(enrolled.body.nonce);
    const renewed = await request('/api/device/renew', renewalBody);
    assert.equal(renewed.status, 200);
    const deviceCertificate = new X509Certificate(renewed.body.deviceCertificatePem);
    const transportCertificate = new X509Certificate(renewed.body.transportCertificatePem);
    assert.equal(deviceCertificate.publicKey.export({ type: 'spki', format: 'pem' }), publicKey);
    assert.equal(transportCertificate.publicKey.export({ type: 'spki', format: 'pem' }), transportPublicKey);
    assert.equal((await request('/api/device/renew', renewalBody)).status, 401, 'challenge is single-use');
    const credential = app.db.prepare('SELECT encrypted_payload FROM proxy_credentials WHERE member_id = ?').get(memberId);
    assert.ok(!credential.encrypted_payload.includes(renewed.body.protocols.vless.uuid));
    const challenge = await request('/api/device/challenge', { deviceId });
    assert.equal(challenge.status, 200);
    const renewedAgain = await request('/api/device/renew', signed(challenge.body.nonce));
    assert.equal(renewedAgain.status, 200);
    assert.equal(renewedAgain.body.protocols.vless.uuid, renewed.body.protocols.vless.uuid, 'unexpired credential is reused');
    assert.notEqual(renewedAgain.body.transportCertificatePem, renewed.body.transportCertificatePem, 'certificate issuance rotates its serial');

    const connection = {
      host: '127.0.0.1', port: gatewayPort, servername: 'localhost',
      ca: readFileSync(join(workspace, 'ca.crt')), cert: renewedAgain.body.transportCertificatePem,
      key: transport.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ALPNProtocols: ['cloudbridge-v2'], minVersion: 'TLSv1.3',
    };
    const echoed = new Promise((resolve, reject) => {
      client = tls.connect(connection, () => client.write('actual-api-issued-certificate'));
      const timer = setTimeout(() => reject(new Error('mTLS echo timed out')), 3_000);
      client.once('data', (data) => { clearTimeout(timer); resolve(data); });
      client.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal((await echoed).toString(), 'actual-api-issued-certificate');
    assert.equal(app.dataPlane.sessions.size, 1);
    const closed = waitClosed(client);
    assert.equal((await request(`/api/members/${memberId}/status`, { status: 'revoked' }, admin)).status, 200);
    await closed;
    await deniedTls(connection);
    const afterRevocation = await request('/api/device/challenge', { deviceId });
    assert.equal(afterRevocation.status, 200);
    const deniedRenewal = await request('/api/device/renew', signed(afterRevocation.body.nonce));
    assert.equal(deniedRenewal.status, 403);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM proxy_credentials WHERE member_id = ? AND revoked_at IS NULL').get(memberId).count, 0);
  } finally {
    client?.destroy();
    if (app) {
      if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
      app.close();
    }
    for (const socket of upstreamSockets) socket.destroy();
    if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});
