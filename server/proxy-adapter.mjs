import { effectiveStatus } from './member-policy.mjs';
import { decryptCredential } from './credential-service.mjs';
import { recordTrafficTotals } from './traffic-usage.mjs';

export class SuiAdapter {
  constructor(options) {
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.token = options.token;
    this.vlessInboundId = Number(options.vlessInboundId);
    this.tuicInboundId = Number(options.tuicInboundId || 0);
  }

  async request(path, init = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Token: this.token, ...init.headers },
      redirect: 'error', // Never forward the S-UI token to a redirect destination.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`S-UI HTTP ${response.status}`);
    const result = await response.json();
    if (!result.success) throw new Error(`S-UI: ${result.msg || 'request failed'}`);
    return result.obj;
  }

  clients(id = '') {
    return this.request(`/clients${id ? `?id=${encodeURIComponent(id)}` : ''}`)
      .then((value) => value?.clients || []);
  }

  saveClient(action, data) {
    const form = new URLSearchParams({ object: 'clients', action, data: JSON.stringify(data), initUsers: '' });
    return this.request('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
  }

  async syncMember(db, memberId, encryptionKey) {
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!member) return;
    const credential = db.prepare(`
      SELECT * FROM proxy_credentials WHERE member_id = ? AND revoked_at IS NULL
      ORDER BY revision DESC LIMIT 1
    `).get(memberId);
    const allClients = await this.clients();
    const managed = allClients.filter((client) => client.desc === memberId);
    const enabled = effectiveStatus(member) === 'active' && credential &&
      new Date(credential.expires_at).getTime() > Date.now();

    if (!credential) {
      for (const client of managed.filter((item) => item.enable)) {
        const [full] = await this.clients(client.id);
        await this.saveClient('edit', { ...full, enable: false });
      }
      return;
    }

    const payload = decryptCredential(credential.encrypted_payload, encryptionKey);
    const existingSummary = managed.find((client) => client.name === credential.sui_client_name);
    const existing = existingSummary ? (await this.clients(existingSummary.id))[0] : null;
    const data = {
      ...(existing || {}),
      enable: Boolean(enabled),
      name: credential.sui_client_name,
      config: {
        vless: { name: credential.sui_client_name, uuid: payload.vlessUuid, flow: '' },
        ...(this.tuicInboundId && payload.tuicUuid ? {
          tuic: { name: credential.sui_client_name, uuid: payload.tuicUuid, password: payload.tuicPassword },
        } : {}),
      },
      inbounds: [this.vlessInboundId, ...(this.tuicInboundId && payload.tuicUuid ? [this.tuicInboundId] : [])],
      links: existing?.links || [],
      volume: Number(member.traffic_quota_bytes),
      expiry: Math.floor(Math.min(new Date(member.expires_at).getTime(), new Date(credential.expires_at).getTime()) / 1000),
      up: existing?.up || 0,
      down: existing?.down || 0,
      desc: memberId,
      group: 'CloudBridge',
      remark: member.name,
      delayStart: false,
      autoReset: false,
      resetDays: 0,
      nextReset: 0,
    };
    await this.saveClient(existing ? 'edit' : 'new', data);
    if (!existing) {
      const created = (await this.clients()).find((client) => client.name === credential.sui_client_name);
      if (created) db.prepare('UPDATE proxy_credentials SET sui_client_id = ? WHERE id = ?').run(created.id, credential.id);
    }
    for (const old of managed.filter((item) => item.name !== credential.sui_client_name && item.enable)) {
      const [full] = await this.clients(old.id);
      await this.saveClient('edit', { ...full, enable: false });
    }
  }

  async syncUsage(db) {
    const clients = await this.clients();
    const now = new Date().toISOString();
    const updateMember = db.prepare('UPDATE members SET traffic_used_bytes = ?, updated_at = ? WHERE id = ?');
    const updateDevice = db.prepare(`
      UPDATE devices SET last_seen_at = ? WHERE member_id = ? AND status = 'active'
    `);
    const totals = new Map();
    for (const client of clients) {
      if (!client.desc) continue;
      const current = totals.get(client.desc) || { upload: 0, download: 0, onlineAt: 0 };
      current.upload += Number(client.up || 0);
      current.download += Number(client.down || 0);
      current.onlineAt = Math.max(current.onlineAt, Number(client.onlineAt || 0));
      totals.set(client.desc, current);
    }
    for (const [memberId, total] of totals) {
      updateMember.run(total.upload + total.download, now, memberId);
      recordTrafficTotals(db, memberId, total.upload, total.download, now);
      if (total.onlineAt) updateDevice.run(new Date(total.onlineAt * 1000).toISOString(), memberId);
    }
  }

  async resetMemberTraffic(memberId) {
    const clients = (await this.clients()).filter((client) => client.desc === memberId);
    for (const client of clients) {
      const [full] = await this.clients(client.id);
      await this.saveClient('edit', { ...full, up: 0, down: 0, totalUp: 0, totalDown: 0 });
    }
  }

  async removeMember(memberId) {
    const clients = (await this.clients()).filter((client) => client.desc === memberId);
    for (const client of clients) await this.saveClient('del', client.id);
  }
}

export function createSuiAdapter(options = {}) {
  if (!options.baseUrl || !options.token || !options.vlessInboundId) return null;
  return new SuiAdapter(options);
}

export function startPolicyWorker(db, options) {
  let running = false;
  let lastUsageSync = 0;
  let lastReconcile = 0;
  const markProcessed = db.prepare(`
    UPDATE policy_jobs SET status = 'processed', processed_at = ?, error = NULL, next_attempt_at = NULL
    WHERE member_id = ? AND status = 'queued'
  `);
  const markRetry = db.prepare(`
    UPDATE policy_jobs SET attempts = attempts + 1, error = ?, next_attempt_at = ?
    WHERE member_id = ? AND status = 'queued'
  `);

  const syncOne = async (memberId) => {
    try {
      await options.adapter.syncMember(db, memberId, options.encryptionKey);
      markProcessed.run(new Date().toISOString(), memberId);
    } catch (error) {
      const row = db.prepare(`
        SELECT COALESCE(MAX(attempts), 0) AS attempts FROM policy_jobs
        WHERE member_id = ? AND status = 'queued'
      `).get(memberId);
      const delay = Math.min(300_000, (options.retryBaseMs || 3_000) * (2 ** Math.min(row.attempts, 7)));
      markRetry.run(String(error.message || error).slice(0, 500), new Date(Date.now() + delay).toISOString(), memberId);
      console.error('S-UI policy sync failed:', error.message || error);
    }
  };

  const tick = async () => {
    if (running || !options.adapter) return;
    running = true;
    try {
      const now = new Date().toISOString();
      const queued = db.prepare(`
        SELECT DISTINCT member_id FROM policy_jobs
        WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY id
      `).all(now);
      const attempted = new Set();
      for (const job of queued) {
        attempted.add(job.member_id);
        await syncOne(job.member_id);
      }
      if (Date.now() - lastReconcile > (options.reconcileMs || 60_000)) {
        const members = db.prepare('SELECT id FROM members ORDER BY id').all();
        for (const member of members) {
          if (!attempted.has(member.id)) await syncOne(member.id);
        }
        lastReconcile = Date.now();
      }
      if (Date.now() - lastUsageSync > (options.usageSyncMs || 30_000)) {
        try {
          await options.adapter.syncUsage(db);
          db.prepare('DELETE FROM traffic_samples WHERE bucket_start < ?')
            .run(new Date(Date.now() - 90 * 86_400_000).toISOString());
          lastUsageSync = Date.now();
        } catch (error) {
          console.error('S-UI usage sync failed:', error.message || error);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, options.intervalMs || 3_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
