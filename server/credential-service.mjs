import { effectiveStatus } from './member-policy.mjs';
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { randomToken, sha256 } from './security.mjs';

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

function nowIso() {
  return new Date().toISOString();
}

function encryptionKey(value) {
  if (!value) throw new Error('CREDENTIAL_ENCRYPTION_KEY 未配置');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64');
  return decoded;
}

export function encryptCredential(payload, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptCredential(value, secret) {
  const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('凭据数据损坏');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
}

export function normalizePublicKey(pem) {
  const key = createPublicKey(String(pem || ''));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw Object.assign(new Error('客户端必须使用 ECDSA P-256 设备密钥'), { status: 400 });
  }
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

export function validateFingerprint(value) {
  const fingerprint = String(value || '').toLowerCase();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw Object.assign(new Error('设备指纹格式无效'), { status: 400 });
  }
  return fingerprint;
}

export function challengeMessage(purpose, deviceId, nonce, fingerprintHash, transportPublicKeyHash = '') {
  if (transportPublicKeyHash) {
    return `cloudbridge:v2:${purpose}:${deviceId}:${nonce}:${fingerprintHash}:${transportPublicKeyHash}`;
  }
  return `cloudbridge:v1:${purpose}:${deviceId}:${nonce}:${fingerprintHash}`;
}

export function issueChallenge(db, deviceId, purpose = 'renew') {
  const nonce = randomToken(32);
  const now = nowIso();
  db.prepare('DELETE FROM device_challenges WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
  db.prepare(`
    INSERT INTO device_challenges(id, device_id, nonce_hash, purpose, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), deviceId, sha256(nonce), purpose,
    new Date(Date.now() + 2 * 60_000).toISOString(), now);
  return { nonce, purpose, expiresInSeconds: 120 };
}

export function verifyChallenge(db, body, purpose = 'renew') {
  const deviceId = String(body.deviceId || '');
  const nonce = String(body.nonce || '');
  const fingerprintHash = validateFingerprint(body.fingerprintHash);
  const challenge = db.prepare(`
    SELECT c.*, d.member_id, d.public_key_pem, d.fingerprint_hash, d.status AS device_status,
           m.status AS member_status, m.expires_at, m.traffic_quota_bytes, m.traffic_used_bytes
    FROM device_challenges c
    JOIN devices d ON d.id = c.device_id
    JOIN members m ON m.id = d.member_id
    WHERE c.device_id = ? AND c.nonce_hash = ? AND c.purpose = ?
      AND c.used_at IS NULL AND c.expires_at > ?
  `).get(deviceId, sha256(nonce), purpose, nowIso());
  if (!challenge) throw Object.assign(new Error('设备挑战无效或已过期'), { status: 401 });
  if (challenge.device_status !== 'active') throw Object.assign(new Error('此设备已解绑'), { status: 403 });
  if (challenge.fingerprint_hash !== fingerprintHash) {
    throw Object.assign(new Error('设备指纹不匹配'), { status: 403 });
  }
  let transportPublicKey = '';
  let transportPublicKeyHash = '';
  if (body.transportPublicKey) {
    const submittedTransportKey = String(body.transportPublicKey);
    try {
      transportPublicKey = normalizePublicKey(submittedTransportKey);
    } catch {
      throw Object.assign(new Error('传输公钥无效'), { status: 400 });
    }
    transportPublicKeyHash = sha256(submittedTransportKey);
  }
  const signature = Buffer.from(String(body.signature || ''), 'base64');
  const valid = verify('sha256', Buffer.from(challengeMessage(
    purpose, deviceId, nonce, fingerprintHash, transportPublicKeyHash,
  )), {
    key: challenge.public_key_pem,
    dsaEncoding: 'ieee-p1363',
  }, signature);
  if (!valid) throw Object.assign(new Error('设备签名校验失败'), { status: 403 });
  db.prepare('UPDATE device_challenges SET used_at = ? WHERE id = ?').run(nowIso(), challenge.id);
  return { ...challenge, transportPublicKey };
}

export function getOrCreateCredential(db, member, device, options) {
  if (effectiveStatus(member) !== 'active') throw Object.assign(new Error('账号当前不可用，请联系管理员'), { status: 403 });
  const existing = db.prepare(`
    SELECT * FROM proxy_credentials
    WHERE member_id = ? AND revision = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(member.id, member.credential_revision, new Date(Date.now() + 60 * 60_000).toISOString());
  if (existing) {
    const payload = decryptCredential(existing.encrypted_payload, options.encryptionKey);
    if (!options.tuicEnabled || (payload.tuicUuid && payload.tuicPassword)) return { row: existing, payload };
  }

  const staleRevision = db.prepare(`
    SELECT id FROM proxy_credentials WHERE member_id = ? AND revision = ?
  `).get(member.id, member.credential_revision);
  if (staleRevision) {
    member.credential_revision += 1;
    db.prepare('UPDATE members SET credential_revision = ?, updated_at = ? WHERE id = ?')
      .run(member.credential_revision, nowIso(), member.id);
  }

  const expiresAt = new Date(Math.min(
    new Date(member.expires_at).getTime(),
    Date.now() + options.credentialHours * 60 * 60_000,
  )).toISOString();
  const suiClientName = `cb_${member.id.replaceAll('-', '').slice(0, 10)}_r${member.credential_revision}`;
  const payload = {
    vlessUuid: randomUUID(),
    ...(options.tuicEnabled ? { tuicUuid: randomUUID(), tuicPassword: randomToken(32) } : {}),
  };
  const row = {
    id: randomUUID(), member_id: member.id, device_id: device.id,
    revision: member.credential_revision, encrypted_payload: encryptCredential(payload, options.encryptionKey),
    sui_client_id: null, sui_client_name: suiClientName, issued_at: nowIso(), expires_at: expiresAt,
  };
  db.prepare('UPDATE proxy_credentials SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(nowIso(), member.id);
  db.prepare(`
    INSERT INTO proxy_credentials(
      id, member_id, device_id, revision, encrypted_payload, sui_client_name, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.member_id, row.device_id, row.revision, row.encrypted_payload,
    row.sui_client_name, row.issued_at, row.expires_at);
  return { row, payload };
}

export function publicProfile(member, device, credential, options) {
  return {
    productName: options.productName,
    deviceId: device.id,
    memberName: member.name,
    expiresAt: member.expires_at,
    credentialExpiresAt: credential.row.expires_at,
    deviceCertificatePem: options.deviceCertificate?.certificatePem || '',
    deviceCertificateExpiresAt: options.deviceCertificate?.expiresAt || credential.row.expires_at,
    transportCertificatePem: options.transportCertificate?.certificatePem || '',
    transportCertificateExpiresAt: options.transportCertificate?.expiresAt || credential.row.expires_at,
    trafficQuotaBytes: member.traffic_quota_bytes,
    trafficUsedBytes: member.traffic_used_bytes,
    maxConnections: member.max_connections,
    server: {
      host: options.proxyHost,
      port: options.dataPlanePort || options.proxyPort,
      serverName: options.proxyServerName,
    },
    protocols: {
      vless: { uuid: credential.payload.vlessUuid, flow: '' },
      ...(options.tuicEnabled && credential.payload.tuicUuid ? {
        tuic: {
          uuid: credential.payload.tuicUuid,
          password: credential.payload.tuicPassword,
          serverPort: options.tuicPort,
          serverName: options.proxyServerName,
          congestionControl: options.tuicCongestionControl,
        },
      } : {}),
    },
  };
}
