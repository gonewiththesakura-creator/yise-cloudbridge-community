import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { createDataPlaneGateway } from '../server/data-plane.mjs';
import { openDatabase } from '../server/db.mjs';
import { createDeviceCertificateIssuer } from '../server/device-certificate.mjs';

const windowsOpenSsl = join(process.env.LOCALAPPDATA || '', 'hermes', 'git', 'usr', 'bin', 'openssl.exe');
const openssl = process.platform === 'win32' && existsSync(windowsOpenSsl) ? windowsOpenSsl : 'openssl';

function run(args, cwd) {
  execFileSync(openssl, args, { cwd, stdio: 'ignore', windowsHide: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function connectTls(options) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options, () => resolve(socket));
    socket.once('error', reject);
  });
}

test('mTLS gateway requires the enrolled device key and revokes live sessions', { timeout: 20_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cloudbridge-mtls-test-'));
  const db = openDatabase(join(workspace, 'test.db'));
  let upstream;
  let gateway;
  let client;
  try {
    run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'ca.key'], workspace);
    run(['req', '-x509', '-new', '-key', 'ca.key', '-subj', '/CN=CloudBridge Test CA', '-days', '2', '-out', 'ca.crt'], workspace);
    run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'server.key'], workspace);
    run(['req', '-new', '-key', 'server.key', '-subj', '/CN=localhost', '-out', 'server.csr'], workspace);
    writeFileSync(join(workspace, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
    run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'server.ext', '-out', 'server.crt'], workspace);
    run(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'device.key'], workspace);
    run(['pkey', '-in', 'device.key', '-pubout', '-out', 'device.pub'], workspace);

    const issuer = createDeviceCertificateIssuer({
      caCertificatePath: join(workspace, 'ca.crt'),
      caPrivateKeyPath: join(workspace, 'ca.key'),
      opensslPath: openssl,
    });
    const issued = await issuer({ deviceId: 'device-1', publicKeyPem: readFileSync(join(workspace, 'device.pub'), 'utf8') });
    writeFileSync(join(workspace, 'device.crt'), issued.certificatePem);

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO members(id, name, expires_at, max_connections, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('member-1', 'Test member', new Date(Date.now() + 86_400_000).toISOString(), 1, now, now);
    db.prepare(`
      INSERT INTO devices(id, member_id, name, public_key_pem, public_key_hash, fingerprint_hash, key_provider, enrolled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('device-1', 'member-1', 'Test device', readFileSync(join(workspace, 'device.pub'), 'utf8'), 'key-hash', 'a'.repeat(64), 'test', now);
    db.prepare(`
      INSERT INTO device_certificates(fingerprint_sha256, device_id, serial_number, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(issued.fingerprintSha256, 'device-1', issued.serialNumber, now, issued.expiresAt);

    upstream = net.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    gateway = createDataPlaneGateway(db, {
      certificatePath: join(workspace, 'server.crt'),
      privateKeyPath: join(workspace, 'server.key'),
      deviceCaCertificatePath: join(workspace, 'ca.crt'),
      internalHost: '127.0.0.1',
      internalPort: upstreamPort,
    });
    const gatewayPort = await listen(gateway.server);

    let unauthenticated;
    try {
      unauthenticated = await connectTls({
        host: '127.0.0.1', port: gatewayPort, servername: 'localhost',
        ca: readFileSync(join(workspace, 'ca.crt')), ALPNProtocols: ['cloudbridge-v2'], minVersion: 'TLSv1.3',
      });
      await new Promise((resolve, reject) => {
        unauthenticated.once('close', resolve);
        unauthenticated.once('error', resolve);
        setTimeout(() => reject(new Error('unauthenticated connection remained open')), 2_000).unref();
        unauthenticated.write('must-not-forward');
      });
    } catch (error) {
      assert.match(String(error.message || error), /certificate|alert|socket|closed/i);
    } finally {
      unauthenticated?.destroy();
    }

    client = await connectTls({
      host: '127.0.0.1', port: gatewayPort, servername: 'localhost',
      ca: readFileSync(join(workspace, 'ca.crt')),
      cert: readFileSync(join(workspace, 'device.crt')),
      key: readFileSync(join(workspace, 'device.key')),
      ALPNProtocols: ['cloudbridge-v2'], minVersion: 'TLSv1.3',
    });
    const echoed = new Promise((resolve) => client.once('data', resolve));
    client.write('device-bound');
    assert.equal((await echoed).toString(), 'device-bound');

    const excess = await connectTls({
      host: '127.0.0.1', port: gatewayPort, servername: 'localhost',
      ca: readFileSync(join(workspace, 'ca.crt')),
      cert: readFileSync(join(workspace, 'device.crt')),
      key: readFileSync(join(workspace, 'device.key')),
      ALPNProtocols: ['cloudbridge-v2'], minVersion: 'TLSv1.3',
    });
    await new Promise((resolve, reject) => {
      excess.once('close', resolve);
      excess.once('error', resolve);
      setTimeout(() => reject(new Error('excess connection remained open')), 2_000).unref();
      excess.write('must-not-forward');
    });
    assert.equal(gateway.sessions.size, 1);

    const closed = new Promise((resolve, reject) => {
      client.once('close', resolve);
      setTimeout(() => reject(new Error('revoked connection remained open')), 5_000).unref();
    });
    db.prepare("UPDATE members SET status = 'suspended' WHERE id = 'member-1'").run();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gateway.sessions.size, 0);
  } finally {
    client?.destroy();
    gateway?.close();
    if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
