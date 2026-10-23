import { effectiveStatus } from './member-policy.mjs';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

function normalizedFingerprint(value) {
  return String(value || '').replaceAll(':', '').toLowerCase();
}

function accessAllowed(row, now = Date.now()) {
  if (!row || row.device_status !== 'active' || row.member_status !== 'active') return false;
  if (effectiveStatus({ ...row, status: row.member_status, expires_at: row.member_expires_at }, now) !== 'active') return false;
  if (new Date(row.certificate_expires_at).getTime() <= now) return false;
  return true;
}

export function createDataPlaneGateway(db, options = {}) {
  if (!options.certificatePath || !options.privateKeyPath || !options.deviceCaCertificatePath) return null;
  const sessions = new Map();
  const findAccess = db.prepare(`
    SELECT dc.expires_at AS certificate_expires_at,
           d.id AS device_id, d.member_id, d.status AS device_status,
           m.status AS member_status, m.expires_at AS member_expires_at,
           m.traffic_quota_bytes, m.traffic_used_bytes, m.max_connections
    FROM device_certificates dc
    JOIN devices d ON d.id = dc.device_id
    JOIN members m ON m.id = d.member_id
    WHERE dc.fingerprint_sha256 = ? AND dc.expires_at > ?
  `);
  const updateSeen = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');

  const server = tls.createServer({
    cert: readFileSync(options.certificatePath),
    key: readFileSync(options.privateKeyPath),
    ca: readFileSync(options.deviceCaCertificatePath),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    ALPNProtocols: ['cloudbridge-v2'],
  });

  server.on('secureConnection', (client) => {
    const peer = client.getPeerCertificate();
    const fingerprint = normalizedFingerprint(peer.fingerprint256);
    const access = findAccess.get(fingerprint, new Date().toISOString());
    if (!client.authorized || client.alpnProtocol !== 'cloudbridge-v2' || !accessAllowed(access)) return client.destroy();
    const currentConnections = [...sessions.values()].filter((item) => item.memberId === access.member_id).length;
    if (currentConnections >= access.max_connections) return client.destroy();

    const session = { fingerprint, memberId: access.member_id, deviceId: access.device_id, upstream: null };
    sessions.set(client, session);
    updateSeen.run(new Date().toISOString(), access.device_id);
    client.setKeepAlive(true, 15_000);

    const upstream = net.createConnection({
      host: options.internalHost || '127.0.0.1',
      port: Number(options.internalPort || 2443),
    });
    session.upstream = upstream;
    const close = () => {
      sessions.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', close);
    upstream.on('close', close);
    client.pipe(upstream).pipe(client);
  });

  server.on('tlsClientError', () => {});
  const revalidateTimer = setInterval(() => {
    const now = new Date().toISOString();
    const perMember = new Map();
    for (const [socket, session] of sessions) {
      const access = findAccess.get(session.fingerprint, now);
      const count = (perMember.get(session.memberId) || 0) + 1;
      perMember.set(session.memberId, count);
      if (!accessAllowed(access) || count > access.max_connections) {
        session.upstream?.destroy();
        socket.destroy();
      }
    }
    db.prepare('DELETE FROM device_certificates WHERE expires_at <= ?').run(now);
  }, 2_000);
  revalidateTimer.unref();

  return {
    server,
    sessions,
    close() {
      clearInterval(revalidateTimer);
      for (const socket of sessions.keys()) socket.destroy();
      server.close();
    },
  };
}
