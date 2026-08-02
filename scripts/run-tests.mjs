// Portable test runner.
//
// `node --test "test/*.test.mjs"` only expands globs on Node 22+, and
// `node --test test/` treats EVERY .mjs under test/ as a test file — which
// would execute fake-server.mjs, a process that waits on stdin forever.
// So: discover the real test files here and pass them explicitly.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, 'test');

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => (process.env.SFCLI_REAL === '1' ? true : !name.includes('integration.real')))
  .map((name) => path.join('test', name))
  .sort();

if (files.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

console.error(`running ${files.length} test file(s): ${files.map((f) => path.basename(f)).join(', ')}`);
const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
