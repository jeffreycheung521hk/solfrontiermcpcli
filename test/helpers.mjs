// Shared test helpers.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI = path.join(ROOT, 'src', 'index.mjs');
export const FAKE = path.join(ROOT, 'test', 'fake-server.mjs');

/**
 * Write a config that launches the fake server with the given flags.
 * Each test gets its own temp directory, so tests never share a database
 * and can run in any order.
 */
export async function writeFakeConfig(dir, fakeFlags = []) {
  const { writeFile } = await import('node:fs/promises');
  const file = path.join(dir, 'sfcli.config.json');
  await writeFile(
    file,
    JSON.stringify({
      serverBin: process.execPath, // node itself runs the fake script
      serverArgs: [FAKE, ...fakeFlags],
      dbPath: path.join(dir, 'scratch.db'),
    }),
  );
  return file;
}
