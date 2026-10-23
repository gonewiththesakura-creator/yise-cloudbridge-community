import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { absolutePath, hostname, isMain, loopback, port, required } from './config.mjs';

export const templateFiles = ['nginx-cloudbridge.conf', 'cloudbridge.service', 's-ui.service', 'cloudbridge-backup.service', 'cloudbridge-backup.timer'];
const paths = ['CB_APP_DIR', 'CB_DATA_DIR', 'CB_CONFIG_FILE', 'DEPLOY_ENV_FILE', 'CB_BACKUP_DIR', 'NODE_BIN', 'BASH_BIN', 'SUI_BINARY_PATH', 'SUI_APP_DIR', 'SUI_DATA_DIR', 'DATA_PLANE_CERT_PATH', 'DATA_PLANE_KEY_PATH', 'ACME_WEBROOT', 'DOWNLOADS_DIR'];
const accounts = ['CB_USER', 'CB_GROUP', 'SUI_USER', 'SUI_GROUP', 'BACKUP_USER', 'BACKUP_GROUP'];

export function templateValues(env) {
  const values = {};
  for (const key of paths) values[key] = absolutePath(env, key).replace(/\/$/, '');
  for (const key of accounts) {
    values[key] = required(env, key);
    if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(values[key])) throw new Error(`${key} must be a system account name`);
  }
  values.PUBLIC_HOST = hostname(env, 'PUBLIC_HOST');
  for (const key of ['HTTP_PORT', 'CONSOLE_TLS_PORT', 'PORT']) values[key] = port(required(env, key), key);
  values.CONSOLE_AUTHORITY = `${values.PUBLIC_HOST}${values.CONSOLE_TLS_PORT === 443 ? '' : `:${values.CONSOLE_TLS_PORT}`}`;
  const upstream = loopback(env, 'HOST');
  values.CONSOLE_UPSTREAM = upstream === '::1' ? '[::1]' : upstream;
  if (values.HTTP_PORT === values.CONSOLE_TLS_PORT) throw new Error('HTTP_PORT and CONSOLE_TLS_PORT must differ');
  if (values.CONSOLE_TLS_PORT === Number(env.DATA_PLANE_PORT || 443)) throw new Error('Console TLS and TCP data plane must use different ports');
  return values;
}

export function renderTemplate(source, values) {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (values[key] === undefined) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}

export async function renderTemplates(env = process.env) {
  const values = templateValues(env);
  return Object.fromEntries(await Promise.all(templateFiles.map(async (file) => [file,
    renderTemplate(await readFile(new URL(file, import.meta.url), 'utf8'), values),
  ])));
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let mode = 'dry-run';
  let output;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--apply' || args[i] === '--dry-run') mode = args[i].slice(2);
    else if (args[i] === '--output-dir' && args[i + 1]) output = resolve(args[++i]);
    else throw new Error('Usage: render-templates.mjs [--dry-run | --apply --output-dir NEW_DIRECTORY]');
  }
  const rendered = await renderTemplates(env);
  if (mode === 'dry-run') {
    process.stdout.write(`${JSON.stringify({ mode, files: rendered }, null, 2)}\n`);
    return;
  }
  if (!output) throw new Error('--apply requires --output-dir; this tool does not install host configuration');
  // A fresh directory prevents overwriting previously reviewed or installed files.
  await mkdir(output, { mode: 0o700 });
  if (!(await lstat(output)).isDirectory()) throw new Error('Output must be a directory');
  for (const [file, content] of Object.entries(rendered)) await writeFile(join(output, file), content, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Rendered ${Object.keys(rendered).length} files in ${output}. Not installed or activated.\n`);
}

if (isMain(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
