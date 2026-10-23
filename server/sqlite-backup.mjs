import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  console.error('Usage: node sqlite-backup.mjs SOURCE DESTINATION');
  process.exit(2);
}

const source = resolve(sourceArgument);
const destination = resolve(destinationArgument);
if (source === destination) throw new Error('Backup destination must differ from source');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const escapedDestination = destination.replaceAll("'", "''");
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${escapedDestination}'`);
} finally {
  db.close();
}
