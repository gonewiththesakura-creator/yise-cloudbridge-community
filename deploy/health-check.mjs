import { createSuiApi, isMain, required } from './config.mjs';

export async function checkHealth(env = process.env, fetchImpl = fetch) {
  const url = new URL(required(env, 'HEALTH_CONSOLE_URL'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid HEALTH_CONSOLE_URL');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote console health requests require HTTPS');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Console HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error('Invalid console JSON response'); }
  if (typeof body.setupRequired !== 'boolean' || typeof body.productName !== 'string') throw new Error('Unexpected /api/bootstrap response');
  const checks = ['CONSOLE_API_OK'];
  if (env.SUI_API_URL || env.SUI_API_TOKEN) {
    await createSuiApi(env, fetchImpl).request('/inbounds');
    checks.push('SUI_API_OK');
  }
  return checks;
}

if (isMain(import.meta.url)) {
  try { console.log((await checkHealth()).join('\n')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
