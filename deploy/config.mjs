import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}

// Never accept the old implicit-mutation `prepare` command.
export function parseMode(args = []) {
  if (args.length === 0) return 'dry-run';
  if (args.length !== 1 || !['--dry-run', '--status', '--apply'].includes(args[0])) {
    throw new Error('Use exactly one of --dry-run (default), --status, or --apply');
  }
  return args[0].slice(2);
}

export function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`${name} must be explicitly configured`);
  return value;
}

export function port(value, name) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return Number(value);
}

export function absolutePath(env, name) {
  const value = required(env, name);
  // Conservative subset shared by shell, nginx and systemd templates. No substitutions.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..') || value === '/') {
    throw new Error(`${name} must be an absolute path without whitespace, traversal, or template syntax`);
  }
  return value;
}

export function hostname(env, name) {
  const value = required(env, name);
  if (value.length > 253 || !value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error(`${name} must be a DNS hostname`);
  }
  return value;
}

export function loopback(env, name) {
  const value = env[name] || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(value)) throw new Error(`${name} must be loopback (127.0.0.1 or ::1)`);
  return value;
}

export function createSuiApi(env, fetchImpl = fetch) {
  const token = required(env, 'SUI_API_TOKEN');
  const rawUrl = required(env, 'SUI_API_URL');
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('SUI_API_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SUI_API_URL must not contain credentials, a query, or a fragment');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error('Remote SUI_API_URL requires HTTPS; plain HTTP is allowed only on loopback');
  }
  const baseUrl = url.href.replace(/\/$/, '');
  async function request(path, init = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Token: token },
      redirect: 'error', // Never forward the API token to a redirect destination.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`S-UI HTTP ${response.status}`);
    let body;
    try { body = await response.json(); } catch { throw new Error('Invalid S-UI JSON response'); }
    // Do not print upstream bodies, which may contain credentials.
    if (!body.success) throw new Error('S-UI request failed');
    return body.obj;
  }
  return {
    request,
    save(object, action, data) {
      if (!['tls', 'inbounds'].includes(object) || !['new', 'edit'].includes(action)) {
        throw new Error('Only explicit inbound and TLS changes are supported');
      }
      return request('/save', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ object, action, data: JSON.stringify(data), initUsers: '' }),
      });
    },
  };
}

export function oneMatch(items, key, value) {
  const matches = items.filter((item) => item[key] === value);
  if (matches.length > 1) throw new Error(`Multiple S-UI objects match ${key} ${value}; resolve the conflict manually`);
  return matches[0];
}

export function needsChange(current, desired) {
  return !current || Object.entries(desired).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value));
}

export function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function assertApplied(current, desired) {
  function matches(actual, expected) {
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
    if (expected && typeof expected === 'object') return Boolean(actual && typeof actual === 'object') && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
    return actual === expected;
  }
  if (!matches(current, desired)) throw new Error('Apply outcome needs operator inspection, no automatic retry: effective configuration does not match the requested security settings');
}
