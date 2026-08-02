// Idempotent local setup: scratch directory, scratch database, config file.
//
// The zero-byte pre-create is deliberate. On at least one Windows setup the
// server child process could not create a brand-new database file itself
// ("unable to open database file"); an existing empty file sidesteps that and
// is harmless everywhere else — SQLite treats it as a new database and the
// server applies its migrations on first open.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = path.join(root, 'scratch');
const devDb = path.join(scratch, 'dev.db');
const configPath = path.join(root, 'sfcli.config.json');

const guessedBin = path.join(
  path.dirname(root),
  'solfrontiermcpskeleton',
  'target',
  'release',
  process.platform === 'win32' ? 'solfrontier-mcp.exe' : 'solfrontier-mcp',
);

await mkdir(scratch, { recursive: true });
console.log(`ok   scratch/            ${scratch}`);

if (!existsSync(devDb)) {
  await writeFile(devDb, '');
  console.log('ok   scratch/dev.db      created (empty; the server migrates it on first open)');
} else {
  console.log('ok   scratch/dev.db      already present');
}

if (!existsSync(configPath)) {
  await writeFile(
    configPath,
    `${JSON.stringify(
      { serverBin: guessedBin, dbPath: 'scratch/dev.db', timeoutMs: 20000 },
      null,
      2,
    )}\n`,
  );
  console.log(`ok   sfcli.config.json   written (serverBin guessed: ${guessedBin})`);
  if (!existsSync(guessedBin)) {
    console.log('     ^ that path does not exist yet — edit it, or pass --bin <path>');
  }
} else {
  console.log('ok   sfcli.config.json   already present, untouched');
}

console.log('\nNever put SOLFRONTIER_RPC_URL in the config file; export it in your shell.');
console.log('Next:  node src/index.mjs doctor');
