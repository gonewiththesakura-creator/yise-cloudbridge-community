import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isMain } from './config.mjs';

export function generateSecrets() {
  return {
    adminUsername: 'admin',
    adminPassword: `Aa1!${randomBytes(24).toString('base64url')}`,
    setupToken: randomBytes(32).toString('base64url'),
    encryptionKey: randomBytes(32).toString('base64'),
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    console.log('DRY RUN: no secrets generated or files written. Use --apply NEW_OUTPUT_FILE. No S-UI account or API token is created.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--apply') throw new Error('Usage: generate-secrets.mjs [--dry-run | --apply NEW_OUTPUT_FILE]');
  const output = resolve(args[1]);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // wx refuses existing files and symlinks instead of silently rotating working keys.
  await writeFile(output, `${JSON.stringify(generateSecrets(), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Secrets saved with mode 0600. No values printed; no external accounts changed.');
}

if (isMain(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
