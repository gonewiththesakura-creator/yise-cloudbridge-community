import { loadAppConfig } from './config.mjs';
import { createLoginLimiter } from './login-limiter.mjs';
import { clampInt, nowIso, addDays, text } from './validation.mjs';
import { effectiveStatus, presentMember, memberPayload } from './member-policy.mjs';
import { compareVersions, versionParts, readUpdatePolicy, validateUpdatePolicy, requireSupportedClient } from './update-policy.mjs';
import { json, errorJson, parseJson, parseCookies, sameOrigin, setCommonHeaders } from './http.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.mjs';
import {
  getOrCreateCredential,
  issueChallenge,
  normalizePublicKey,
  publicProfile,
  validateFingerprint,
  verifyChallenge,
} from './credential-service.mjs';
import {
  activationCode,
  hashPassword,
  passwordPolicyError,
  randomToken,
  sha256,
  verifyPassword,
} from './security.mjs';
import { createSuiAdapter, startPolicyWorker } from './proxy-adapter.mjs';
import { createDeviceCertificateIssuer } from './device-certificate.mjs';
import { createDataPlaneGateway } from './data-plane.mjs';
import { recordTrafficDelta, recordTrafficTotals, trafficSeries } from './traffic-usage.mjs';

const STATUS_VALUES = new Set(['active', 'suspended', 'revoked']);

const memberSelect = `
  SELECT m.*, d.id AS device_id, d.name AS device_name, d.status AS device_status,
         d.public_key_hash, d.fingerprint_hash, d.key_provider, d.enrolled_at, d.last_seen_at
  FROM members m
  LEFT JOIN devices d ON d.member_id = m.id AND d.status = 'active'
`;

function queuePolicy(db, memberId, action, payload = {}) {
  db.prepare(`
    INSERT INTO policy_jobs(member_id, action, payload, created_at)
    VALUES (?, ?, ?, ?)
  `).run(memberId, action, JSON.stringify(payload), nowIso());
}

function audit(db, adminId, memberId, action, detail) {
  db.prepare(`
    INSERT INTO audit_logs(admin_id, member_id, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(adminId, memberId || null, action, detail, nowIso());
}

function findMember(db, id) {
  return db.prepare(`${memberSelect} WHERE m.id = ?`).get(id);
}

function requireSession(db, req, res, csrf = false) {
  const token = parseCookies(req.headers.cookie).friendlink_session;
  if (!token) {
    errorJson(res, 401, '请先登录');
    return null;
  }
  const session = db.prepare(`
    SELECT s.*, a.username FROM sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), nowIso());
  if (!session) {
    errorJson(res, 401, '登录已过期');
    return null;
  }
  if (csrf && req.headers['x-csrf-token'] !== session.csrf_token) {
    errorJson(res, 403, '安全校验失败，请刷新页面');
    return null;
  }
  return session;
}

function sessionCookie(token, options, clear = false) {
  const secure = options.cookieSecure ? '; Secure' : '';
  const maxAge = clear ? 0 : options.sessionDays * 86_400;
  return `friendlink_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clientAddress(req, trustProxy) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustProxy || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return remote;
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || remote;
}

async function apiHandler(db, req, res, options, loginLimiter) {
  const { loginAllowed, recordLoginFailure, clearLoginFailures } = loginLimiter;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';

  if (!sameOrigin(req)) return errorJson(res, 403, '来源校验失败');

  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    const setupRequired = db.prepare('SELECT COUNT(*) AS count FROM admins').get().count === 0;
    return json(res, 200, { setupRequired, productName: options.productName });
  }

  if (method === 'GET' && url.pathname === '/api/client/update') {
    const platform = text(url.searchParams.get('platform'), 32, 'windows-x64');
    if (platform !== 'windows-x64') return errorJson(res, 404, '暂不支持该客户端平台');
    const currentVersion = text(url.searchParams.get('version'), 32);
    const policy = readUpdatePolicy(db, options);
    const latestComparison = compareVersions(currentVersion, policy.latestVersion);
    const minimumComparison = compareVersions(currentVersion, policy.minimumVersion);
    const available = Boolean(policy.enabled && versionParts(policy.latestVersion));
    return json(res, 200, {
      ...policy,
      available,
      currentVersion,
      updateAvailable: available && (latestComparison === null || latestComparison < 0),
      required: available && (minimumComparison === null || minimumComparison < 0),
    });
  }

  if (method === 'POST' && url.pathname === '/api/device/register') {
    const body = await parseJson(req);
    if (!requireSupportedClient(db, options, body, res)) return;
    const codeHash = sha256(text(body.activationCode, 32).toUpperCase());
    const activation = db.prepare(`
      SELECT a.*, m.status AS member_status, m.expires_at AS member_expires_at,
             m.traffic_quota_bytes, m.traffic_used_bytes
      FROM activation_codes a JOIN members m ON m.id = a.member_id
      WHERE a.code_hash = ? AND a.used_at IS NULL AND a.expires_at > ?
    `).get(codeHash, nowIso());
    if (!activation) return errorJson(res, 400, '激活码无效或已过期');
    if (activation.member_status !== 'active' || new Date(activation.member_expires_at).getTime() <= Date.now()) {
      return errorJson(res, 403, '账号当前不可激活');
    }
    const existing = db.prepare("SELECT id FROM devices WHERE member_id = ? AND status = 'active'").get(activation.member_id);
    if (existing) return errorJson(res, 409, '该账号已经绑定设备，请先在后台解绑');
    let publicKey;
    try {
      publicKey = normalizePublicKey(body.publicKey);
    } catch (error) {
      return errorJson(res, error.status || 400, error.status ? error.message : '设备公钥无效');
    }
    const fingerprintHash = validateFingerprint(body.fingerprintHash);
    const deviceId = randomUUID();
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO devices(
          id, member_id, name, public_key_pem, public_key_hash, fingerprint_hash,
          key_provider, status, enrolled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(deviceId, activation.member_id, text(body.deviceName, 100, 'Windows 设备'), publicKey,
        sha256(publicKey), fingerprintHash, text(body.keyProvider, 60, 'unknown'), now);
      db.prepare('UPDATE activation_codes SET used_at = ? WHERE id = ?').run(now, activation.id);
      queuePolicy(db, activation.member_id, 'device.enrolled', { deviceId });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) return errorJson(res, 409, '该设备已经注册过');
      throw error;
    }
    return json(res, 201, { deviceId, ...issueChallenge(db, deviceId) });
  }

  if (method === 'POST' && url.pathname === '/api/device/challenge') {
    const body = await parseJson(req);
    const deviceId = text(body.deviceId, 64);
    const device = db.prepare("SELECT id FROM devices WHERE id = ? AND status = 'active'").get(deviceId);
    if (!device) return errorJson(res, 404, '设备不存在或已解绑');
    return json(res, 200, issueChallenge(db, deviceId));
  }

  if (method === 'POST' && url.pathname === '/api/device/renew') {
    const body = await parseJson(req);
    if (!requireSupportedClient(db, options, body, res)) return;
    const verified = verifyChallenge(db, body);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(verified.member_id);
    const device = db.prepare("SELECT * FROM devices WHERE id = ? AND status = 'active'").get(verified.device_id);
    if (!member || !device) return errorJson(res, 404, '设备或账号不存在');
    const credential = getOrCreateCredential(db, member, device, options);
    if (!options.certificateIssuer) return errorJson(res, 503, '设备证书服务尚未配置');
    const deviceCertificate = await options.certificateIssuer({
      deviceId: device.id,
      publicKeyPem: device.public_key_pem,
    });
    const transportCertificate = verified.transportPublicKey
      ? await options.certificateIssuer({
        deviceId: device.id,
        publicKeyPem: verified.transportPublicKey,
      })
      : null;
    db.prepare(`
      INSERT OR REPLACE INTO device_certificates(
        fingerprint_sha256, device_id, serial_number, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(deviceCertificate.fingerprintSha256, device.id, deviceCertificate.serialNumber,
      nowIso(), deviceCertificate.expiresAt);
    if (transportCertificate) {
      db.prepare(`
        INSERT OR REPLACE INTO device_certificates(
          fingerprint_sha256, device_id, serial_number, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(transportCertificate.fingerprintSha256, device.id, transportCertificate.serialNumber,
        nowIso(), transportCertificate.expiresAt);
    }
    const now = nowIso();
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
    queuePolicy(db, member.id, 'credential.renewed', { revision: credential.row.revision });
    if (options.adapter) await options.adapter.syncMember(db, member.id, options.encryptionKey);
    return json(res, 200, publicProfile(member, { ...device, last_seen_at: now }, credential, {
      ...options,
      deviceCertificate,
      transportCertificate,
    }));
  }

  if (method === 'POST' && url.pathname === '/api/setup') {
    if (db.prepare('SELECT COUNT(*) AS count FROM admins').get().count > 0) {
      return errorJson(res, 409, '系统已经初始化');
    }
    const body = await parseJson(req);
    if (options.setupToken && sha256(String(body.setupToken || '')) !== sha256(options.setupToken)) {
      return errorJson(res, 403, '初始化令牌无效');
    }
    const username = text(body.username, 40, 'admin');
    const password = typeof body.password === 'string' ? body.password : '';
    if (username.length < 3) return errorJson(res, 400, '管理员账号至少3个字符');
    const passwordError = passwordPolicyError(password);
    if (passwordError) return errorJson(res, 400, passwordError);
    const { hash, salt } = hashPassword(password);
    const createdAt = nowIso();
    const result = db.prepare(`
      INSERT INTO admins(username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?)
    `).run(username, hash, salt, createdAt);
    audit(db, Number(result.lastInsertRowid), null, 'setup', '完成控制台初始化');
    return json(res, 201, { ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const ip = clientAddress(req, options.trustProxy);
    if (!loginAllowed(ip)) return errorJson(res, 429, '登录尝试过多，请稍后再试');
    const body = await parseJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(text(body.username, 40));
    if (!admin || !verifyPassword(String(body.password || ''), admin.password_salt, admin.password_hash)) {
      recordLoginFailure(ip);
      return errorJson(res, 401, '账号或密码错误');
    }
    clearLoginFailures(ip);
    const token = randomToken();
    const csrfToken = randomToken(24);
    const createdAt = nowIso();
    const expiresAt = addDays(new Date(), options.sessionDays).toISOString();
    db.prepare(`
      INSERT INTO sessions(token_hash, admin_id, csrf_token, expires_at, created_at, mfa_verified)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sha256(token), admin.id, csrfToken, expiresAt, createdAt, 1);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(createdAt);
    return json(res, 200, {
      username: admin.username,
      csrfToken,
    }, {
      'set-cookie': sessionCookie(token, options),
    });
  }

  if (method === 'POST' && url.pathname === '/api/adapter/usage') {
    const expectedToken = options.proxyAdapterToken;
    const suppliedToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!expectedToken || sha256(suppliedToken) !== sha256(expectedToken)) {
      return errorJson(res, 401, '适配器认证失败');
    }
    const body = await parseJson(req);
    if (!Array.isArray(body.records) || body.records.length > 500) {
      return errorJson(res, 400, '流量记录无效');
    }
    const updateTraffic = db.prepare(`
      UPDATE members SET traffic_used_bytes = traffic_used_bytes + ?, updated_at = ? WHERE id = ?
    `);
    const updateDevice = db.prepare(`
      UPDATE devices SET last_seen_at = ? WHERE member_id = ? AND status = 'active'
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of body.records) {
        const memberId = text(record.memberId, 64);
        const delta = clampInt(record.trafficDeltaBytes, 0, Number.MAX_SAFE_INTEGER, 0);
        if (!memberId || !delta) continue;
        updateTraffic.run(delta, nowIso(), memberId);
        recordTrafficDelta(db, memberId, delta);
        if (record.lastSeenAt) {
          const lastSeen = new Date(record.lastSeenAt);
          if (!Number.isNaN(lastSeen.getTime())) updateDevice.run(lastSeen.toISOString(), memberId);
        }
        const member = findMember(db, memberId);
        if (member && effectiveStatus(member) === 'quota_exceeded') {
          queuePolicy(db, memberId, 'member.quota_exceeded');
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 202, { accepted: body.records.length });
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    const session = requireSession(db, req, res, true);
    if (!session) return;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', options, true) });
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    const session = requireSession(db, req, res);
    if (!session) return;
    return json(res, 200, {
      username: session.username,
      csrfToken: session.csrf_token,
    });
  }

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const session = requireSession(db, req, res, mutating);
  if (!session) return;

  if (method === 'POST' && url.pathname === '/api/account/password') {
    const body = await parseJson(req);
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(session.admin_id);
    if (!verifyPassword(String(body.currentPassword || ''), admin.password_salt, admin.password_hash)) {
      return errorJson(res, 400, '当前密码错误');
    }
    const newPassword = String(body.newPassword || '');
    const passwordError = passwordPolicyError(newPassword);
    if (passwordError) return errorJson(res, 400, passwordError);
    if (verifyPassword(newPassword, admin.password_salt, admin.password_hash)) {
      return errorJson(res, 400, '新密码不能与当前密码相同');
    }
    const { hash, salt } = hashPassword(newPassword);
    db.prepare('UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(hash, salt, admin.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?')
      .run(admin.id, session.token_hash);
    audit(db, admin.id, null, 'admin.password_changed', '管理员已修改登录密码');
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && url.pathname === '/api/client-update') {
    return json(res, 200, { policy: readUpdatePolicy(db, options) });
  }

  if (method === 'PUT' && url.pathname === '/api/client-update') {
    const existing = readUpdatePolicy(db, options);
    const policy = validateUpdatePolicy(await parseJson(req), existing);
    db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('client-update:windows-x64', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(policy), nowIso());
    audit(db, session.admin_id, null, 'client.update_policy',
      `发布 Windows 客户端 ${policy.latestVersion}，最低版本 ${policy.minimumVersion}`);
    return json(res, 200, { policy });
  }

  if (method === 'GET' && url.pathname === '/api/dashboard') {
    const rows = db.prepare(`${memberSelect} ORDER BY m.created_at DESC`).all().map(presentMember);
    const active = rows.filter((item) => item.status === 'active').length;
    const online = rows.filter((item) => item.device?.online).length;
    const expiringSoon = rows.filter((item) => {
      const remaining = new Date(item.expiresAt).getTime() - Date.now();
      return remaining > 0 && remaining <= 7 * 86_400_000;
    }).length;
    const trafficUsedBytes = rows.reduce((total, item) => total + item.trafficUsedBytes, 0);
    const queuedJobs = db.prepare("SELECT COUNT(*) AS count FROM policy_jobs WHERE status = 'queued'").get().count;
    const failedJobs = db.prepare("SELECT COUNT(*) AS count FROM policy_jobs WHERE status = 'queued' AND error IS NOT NULL").get().count;
    return json(res, 200, {
      summary: { total: rows.length, active, online, expiringSoon, trafficUsedBytes, queuedJobs, failedJobs },
      members: rows,
    });
  }

  if (method === 'GET' && url.pathname === '/api/traffic') {
    const memberId = url.searchParams.get('memberId');
    if (memberId !== null && !findMember(db, memberId)) return errorJson(res, 404, '成员不存在');
    return json(res, 200, trafficSeries(db, url.searchParams.get('range') || '24h', memberId));
  }

  if (method === 'GET' && url.pathname === '/api/members') {
    const search = `%${text(url.searchParams.get('search') || '', 80)}%`;
    const rows = db.prepare(`${memberSelect}
      WHERE m.name LIKE ? OR m.note LIKE ?
      ORDER BY m.created_at DESC
    `).all(search, search).map(presentMember);
    return json(res, 200, { members: rows });
  }

  if (method === 'POST' && url.pathname === '/api/members') {
    const body = await parseJson(req);
    if (!body.expiresAt) body.expiresAt = addDays(new Date(), clampInt(body.durationDays, 1, 3650, 30)).toISOString();
    const payload = memberPayload(body);
    const id = randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO members(
        id, name, note, expires_at, traffic_quota_bytes, max_connections, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, payload.name, payload.note, payload.expiresAt, payload.trafficQuotaBytes,
      payload.maxConnections, now, now);
    queuePolicy(db, id, 'member.created', payload);
    audit(db, session.admin_id, id, 'member.created', `添加成员 ${payload.name}`);
    return json(res, 201, { member: presentMember(findMember(db, id)) });
  }

  const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && method === 'DELETE') {
    const id = memberMatch[1];
    const existing = findMember(db, id);
    if (!existing) return errorJson(res, 404, '成员不存在');
    if (existing.status !== 'revoked') return errorJson(res, 409, '请先注销成员，再永久删除');
    if (options.adapter) await options.adapter.removeMember(id);
    audit(db, session.admin_id, id, 'member.deleted', `永久删除 ${existing.name}`);
    db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return json(res, 200, { ok: true });
  }
  if (memberMatch && method === 'PATCH') {
    const id = memberMatch[1];
    const existing = findMember(db, id);
    if (!existing) return errorJson(res, 404, '成员不存在');
    const payload = memberPayload(await parseJson(req), existing);
    const now = nowIso();
    db.prepare(`
      UPDATE members SET name = ?, note = ?, expires_at = ?, traffic_quota_bytes = ?,
        max_connections = ?, updated_at = ? WHERE id = ?
    `).run(payload.name, payload.note, payload.expiresAt, payload.trafficQuotaBytes,
      payload.maxConnections, now, id);
    queuePolicy(db, id, 'member.updated', payload);
    audit(db, session.admin_id, id, 'member.updated', `更新 ${payload.name} 的使用策略`);
    return json(res, 200, { member: presentMember(findMember(db, id)) });
  }

  const actionMatch = url.pathname.match(/^\/api\/members\/([^/]+)\/(extend|status|reset-traffic|reset-device|activation-code)$/);
  if (actionMatch && method === 'POST') {
    const [, id, action] = actionMatch;
    const existing = findMember(db, id);
    if (!existing) return errorJson(res, 404, '成员不存在');
    const body = await parseJson(req);
    const now = nowIso();

    if (action === 'extend') {
      const days = clampInt(body.days, 1, 3650, 30);
      const base = Math.max(Date.now(), new Date(existing.expires_at).getTime());
      const expiresAt = addDays(new Date(base), days).toISOString();
      db.prepare("UPDATE members SET expires_at = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(expiresAt, now, id);
      queuePolicy(db, id, 'member.extended', { days, expiresAt });
      audit(db, session.admin_id, id, 'member.extended', `为 ${existing.name} 延期 ${days} 天`);
    }

    if (action === 'status') {
      const status = String(body.status || '');
      if (!STATUS_VALUES.has(status)) return errorJson(res, 400, '状态无效');
      db.prepare('UPDATE members SET status = ?, updated_at = ?, credential_revision = credential_revision + 1 WHERE id = ?')
        .run(status, now, id);
      db.prepare('UPDATE proxy_credentials SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now, id);
      queuePolicy(db, id, 'member.status', { status });
      const statusName = { active: '启用', suspended: '暂停', revoked: '注销' }[status];
      audit(db, session.admin_id, id, 'member.status', `${statusName} ${existing.name}`);
    }

    if (action === 'reset-traffic') {
      db.prepare('UPDATE members SET traffic_used_bytes = 0, updated_at = ? WHERE id = ?').run(now, id);
      recordTrafficTotals(db, id, 0, 0, now);
      if (options.adapter) await options.adapter.resetMemberTraffic(id);
      queuePolicy(db, id, 'member.traffic_reset');
      audit(db, session.admin_id, id, 'member.traffic_reset', `清零 ${existing.name} 的流量`);
    }

    if (action === 'reset-device') {
      db.prepare(`
        UPDATE devices
        SET status = 'revoked', revoked_at = ?, public_key_hash = 'revoked:' || id
        WHERE member_id = ? AND status = 'active'
      `).run(now, id);
      db.prepare('UPDATE members SET credential_revision = credential_revision + 1, updated_at = ? WHERE id = ?')
        .run(now, id);
      db.prepare('UPDATE proxy_credentials SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now, id);
      queuePolicy(db, id, 'member.device_reset');
      audit(db, session.admin_id, id, 'member.device_reset', `解绑 ${existing.name} 的设备`);
    }

    if (action === 'activation-code') {
      const code = activationCode();
      const expiresInMinutes = clampInt(body.expiresInMinutes, 5, 1440, 30);
      db.prepare('DELETE FROM activation_codes WHERE member_id = ? AND used_at IS NULL').run(id);
      db.prepare(`
        INSERT INTO activation_codes(id, member_id, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), id, sha256(code), new Date(Date.now() + expiresInMinutes * 60_000).toISOString(), now);
      audit(db, session.admin_id, id, 'activation.created', `为 ${existing.name} 生成一次性激活码`);
      return json(res, 201, { code, expiresInMinutes });
    }

    return json(res, 200, { member: presentMember(findMember(db, id)) });
  }

  if (method === 'GET' && url.pathname === '/api/audit') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    const rows = db.prepare(`
      SELECT a.id, a.action, a.detail, a.created_at, m.name AS member_name, ad.username
      FROM audit_logs a
      LEFT JOIN members m ON m.id = a.member_id
      LEFT JOIN admins ad ON ad.id = a.admin_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit);
    return json(res, 200, { logs: rows.map((row) => ({
      id: row.id,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at,
      memberName: row.member_name,
      username: row.username,
    })) });
  }

  return errorJson(res, 404, '接口不存在');
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function staticHandler(req, res, distDir) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let filePath = resolve(distDir, `.${decodeURIComponent(url.pathname)}`);
  const root = resolve(distDir);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return errorJson(res, 403, '禁止访问');
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
  } catch {
    filePath = resolve(root, 'index.html');
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch {
    errorJson(res, 404, '前端尚未构建，请先运行 npm run build');
  }
}

export function createFriendLinkApp(overrides = {}, environment = process.env) {
  const options = loadAppConfig(overrides, environment);
  const loginLimiter = createLoginLimiter();
  options.adapter = overrides.adapter !== undefined ? overrides.adapter : createSuiAdapter(options.sui);
  options.certificateIssuer = overrides.certificateIssuer !== undefined
    ? overrides.certificateIssuer : createDeviceCertificateIssuer(options.deviceCa);
  const db = openDatabase(options.dbPath);
  const dataPlane = options.disableDataPlane ? null : createDataPlaneGateway(db, options.dataPlane);
  const initialAdminPassword = options.initialAdminPassword;
  if (initialAdminPassword && db.prepare('SELECT COUNT(*) AS count FROM admins').get().count === 0) {
    const username = options.initialAdminUsername;
    const { hash, salt } = hashPassword(initialAdminPassword);
    const result = db.prepare(`
      INSERT INTO admins(username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)
    `).run(username, hash, salt, nowIso());
    audit(db, Number(result.lastInsertRowid), null, 'setup', '通过服务器初始化管理员');
  }
  const stopWorker = options.disableWorker ? () => {} : startPolicyWorker(db, {
    adapter: options.adapter,
    encryptionKey: options.encryptionKey,
  });

  const server = createServer(async (req, res) => {
    setCommonHeaders(res);
    try {
      if (req.url.startsWith('/api/')) await apiHandler(db, req, res, options, loginLimiter);
      else await staticHandler(req, res, options.distDir);
    } catch (error) {
      if (!res.headersSent) errorJson(res, error.status || 500, error.status ? error.message : '服务器内部错误');
      else res.end();
      if (!error.status) console.error(error);
    }
  });

  return {
    server,
    dataPlane,
    db,
    options,
    close: () => {
      stopWorker();
      dataPlane?.close();
      server.close();
      db.close();
    },
  };
}
