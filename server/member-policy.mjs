import { clampInt, text } from './validation.mjs';

export function effectiveStatus(member, now = Date.now()) {
  if (member.status !== 'active') return member.status;
  if (new Date(member.expires_at).getTime() <= now) return 'expired';
  if (member.traffic_quota_bytes > 0 && member.traffic_used_bytes >= member.traffic_quota_bytes) {
    return 'quota_exceeded';
  }
  return 'active';
}

export function presentMember(row) {
  const online = row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < 120_000;
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    status: effectiveStatus(row),
    configuredStatus: row.status,
    expiresAt: row.expires_at,
    trafficQuotaBytes: row.traffic_quota_bytes,
    trafficUsedBytes: row.traffic_used_bytes,
    maxConnections: row.max_connections,
    credentialRevision: row.credential_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    device: row.device_id ? {
      id: row.device_id,
      name: row.device_name,
      status: row.device_status,
      publicKeyHash: row.public_key_hash,
      fingerprintHash: row.fingerprint_hash,
      keyProvider: row.key_provider,
      enrolledAt: row.enrolled_at,
      lastSeenAt: row.last_seen_at,
      online: Boolean(online),
    } : null,
  };
}

export function memberPayload(body, existing = {}) {
  const name = text(body.name, 80, existing.name || '');
  if (!name) throw Object.assign(new Error('请输入成员名称'), { status: 400 });
  const expiresAt = body.expiresAt || existing.expires_at;
  if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime())) {
    throw Object.assign(new Error('到期时间无效'), { status: 400 });
  }
  return {
    name,
    note: text(body.note, 240, existing.note || ''),
    expiresAt: new Date(expiresAt).toISOString(),
    trafficQuotaBytes: clampInt(body.trafficQuotaBytes, 0, Number.MAX_SAFE_INTEGER, existing.traffic_quota_bytes || 0),
    maxConnections: clampInt(body.maxConnections, 1, 100, existing.max_connections || 2),
  };
}

