import { assertApplied, createSuiApi, isMain, loopback, needsChange, oneMatch, parseMode, port, writeResult } from './config.mjs';

export function internalProfile(env) {
  const listen = loopback(env, 'DATA_PLANE_INTERNAL_HOST');
  return {
    type: 'vless', tag: env.SUI_VLESS_TAG || 'cloudbridge-vless-internal', tls_id: 0,
    listen, listen_port: port(env.DATA_PLANE_INTERNAL_PORT || 2443, 'DATA_PLANE_INTERNAL_PORT'),
    tcp_fast_open: true, addrs: [listen], out_json: {},
    multiplex: { enabled: true, padding: false },
  };
}

export async function configureInternal({ mode = 'dry-run', env = process.env, api } = {}) {
  if (!['dry-run', 'status', 'apply'].includes(mode)) throw new Error('Invalid mode');
  const desired = internalProfile(env);
  if (mode === 'dry-run') return { mode, offline: true, desired, note: 'No API calls. Use --status to inspect; --apply may create or edit this inbound.' };
  api ||= createSuiApi(env);
  const listed = (await api.request('/inbounds'))?.inbounds || [];
  let current = oneMatch(listed, 'tag', desired.tag);
  if (mode === 'status') return { mode, inbound: current ? { id: current.id, tag: current.tag, type: current.type, listen: current.listen, port: current.listen_port } : null };
  if (current && current.type !== 'vless') throw new Error('Matching inbound is not VLESS; refusing to replace it');
  if (current) {
    const values = (await api.request(`/inbounds?id=${encodeURIComponent(current.id)}`))?.inbounds || [];
    current = values.find((item) => String(item.id) === String(current.id));
    if (!current) throw new Error('Inbound disappeared during update');
  }
  // Preserve unrelated options and users when modifying an existing inbound.
  const merged = current ? { ...current, ...desired, multiplex: { ...current.multiplex, ...desired.multiplex }, out_json: current.out_json ?? desired.out_json } : desired;
  const changed = needsChange(current, merged);
  if (changed) await api.save('inbounds', current ? 'edit' : 'new', merged);
  const confirmed = oneMatch((await api.request('/inbounds'))?.inbounds || [], 'tag', desired.tag);
  if (!confirmed) throw new Error('Apply outcome needs operator inspection, no automatic retry: inbound missing');
  const effective = ((await api.request(`/inbounds?id=${encodeURIComponent(confirmed.id)}`))?.inbounds || []).find((item) => String(item.id) === String(confirmed.id));
  assertApplied(effective, desired);
  return { mode, changed, vlessInboundId: confirmed.id, listen: confirmed.listen, port: confirmed.listen_port };
}

if (isMain(import.meta.url)) {
  try { writeResult(await configureInternal({ mode: parseMode(process.argv.slice(2)) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
