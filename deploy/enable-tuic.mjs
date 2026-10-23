import { isIP } from 'node:net';
import { assertApplied, absolutePath, createSuiApi, hostname, isMain, needsChange, oneMatch, parseMode, port, writeResult } from './config.mjs';

export function tuicProfiles(env) {
  const serverName = hostname(env, 'PROXY_SERVER_NAME');
  const listen = env.TUIC_LISTEN_HOST || env.DATA_PLANE_HOST || '127.0.0.1';
  if (!isIP(listen)) throw new Error('TUIC_LISTEN_HOST must be an IP address');
  const congestion = env.TUIC_CONGESTION_CONTROL || 'bbr';
  if (!['bbr', 'cubic', 'new_reno'].includes(congestion)) throw new Error('Invalid TUIC_CONGESTION_CONTROL');
  return {
    tls: {
      name: env.SUI_TUIC_TLS_NAME || 'cloudbridge-tuic-mtls',
      server: {
        enabled: true, server_name: serverName, alpn: ['h3'], min_version: '1.3',
        certificate_path: absolutePath(env, 'DATA_PLANE_CERT_PATH'),
        key_path: absolutePath(env, 'DATA_PLANE_KEY_PATH'),
        client_authentication: 'require-and-verify',
        client_certificate_path: [absolutePath(env, 'DEVICE_CA_CERT_PATH')],
      },
      client: { enabled: true, server_name: serverName, alpn: ['h3'], min_version: '1.3' },
    },
    inbound: {
      type: 'tuic', tag: env.SUI_TUIC_TAG || 'cloudbridge-tuic-mtls',
      listen, listen_port: port(env.TUIC_PORT || 443, 'TUIC_PORT'),
      congestion_control: congestion, zero_rtt_handshake: false, heartbeat: '10s', auth_timeout: '3s',
      addrs: [serverName], out_json: { udp_relay_mode: 'native' },
    },
  };
}

export async function configureTuic({ mode = 'dry-run', env = process.env, api } = {}) {
  if (!['dry-run', 'status', 'apply'].includes(mode)) throw new Error('Invalid mode');
  const desired = tuicProfiles(env);
  if (mode === 'dry-run') return { mode, offline: true, ...desired, note: 'No API calls. --apply creates or edits TLS and inbound objects, not API tokens or firewall rules.' };
  api ||= createSuiApi(env);
  const configs = (await api.request('/tls'))?.tls || [];
  const inbounds = (await api.request('/inbounds'))?.inbounds || [];
  const tls = oneMatch(configs, 'name', desired.tls.name);
  let inbound = oneMatch(inbounds, 'tag', desired.inbound.tag);
  if (mode === 'status') return { mode, tlsId: tls?.id ?? null, inbound: inbound ? { id: inbound.id, tag: inbound.tag, type: inbound.type, listen: inbound.listen, port: inbound.listen_port, tlsId: inbound.tls_id } : null };
  if (inbound && inbound.type !== 'tuic') throw new Error('Matching inbound is not TUIC; refusing to replace it');
  if (inbound) {
    const full = (await api.request(`/inbounds?id=${encodeURIComponent(inbound.id)}`))?.inbounds || [];
    inbound = full.find((item) => String(item.id) === String(inbound.id));
    if (!inbound) throw new Error('Inbound disappeared during update');
  }
  const mergedTls = tls ? { ...tls, ...desired.tls, server: { ...tls.server, ...desired.tls.server }, client: { ...tls.client, ...desired.tls.client } } : desired.tls;
  const tlsChanged = needsChange(tls, mergedTls);
  if (tlsChanged) await api.save('tls', tls ? 'edit' : 'new', mergedTls);
  const confirmedTls = oneMatch((await api.request('/tls'))?.tls || [], 'name', desired.tls.name);
  if (!confirmedTls?.id) throw new Error('Apply outcome needs operator inspection, no automatic retry: TLS profile missing');
  assertApplied(confirmedTls, desired.tls);
  const mergedInbound = { ...inbound, ...desired.inbound, tls_id: confirmedTls.id, out_json: { ...inbound?.out_json, ...desired.inbound.out_json } };
  const inboundChanged = needsChange(inbound, mergedInbound);
  if (inboundChanged) await api.save('inbounds', inbound ? 'edit' : 'new', mergedInbound);
  const confirmed = oneMatch((await api.request('/inbounds'))?.inbounds || [], 'tag', desired.inbound.tag);
  if (!confirmed?.id) throw new Error('Apply outcome needs operator inspection, no automatic retry: TUIC inbound missing');
  const effective = ((await api.request(`/inbounds?id=${encodeURIComponent(confirmed.id)}`))?.inbounds || []).find((item) => String(item.id) === String(confirmed.id));
  assertApplied(effective, { ...desired.inbound, tls_id: confirmedTls.id });
  return { mode, tlsChanged, inboundChanged, tuicInboundId: confirmed.id, tlsId: confirmedTls.id };
}

if (isMain(import.meta.url)) {
  try { writeResult(await configureTuic({ mode: parseMode(process.argv.slice(2)) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
