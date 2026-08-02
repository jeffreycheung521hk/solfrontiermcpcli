// End-to-end CLI behaviour against the fake server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CLI, ROOT, writeFakeConfig } from './helpers.mjs';

/** Run the CLI with a per-test config that launches the fake with flags. */
async function run(args, { fakeFlags = [], env = {}, timeoutMs = 20000 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sfcli-'));
  const configPath = await writeFakeConfig(dir, fakeFlags);
  try {
    return await new Promise((resolve) => {
      const childEnv = { ...process.env, SFCLI_CONFIG: configPath, SFCLI_TIMEOUT_MS: String(timeoutMs), NO_COLOR: '1', ...env };
      delete childEnv.SOLFRONTIER_RPC_URL;
      delete childEnv.SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR;
      execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv }, (error, stdout, stderr) =>
        resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('discovery', () => {
  test('tools list prints the fake tools and exits 0', async () => {
    const r = await run(['tools', 'list']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['echo_tool', 'strict_tool']);
  });

  test('--json emits exactly one parseable document on stdout', async () => {
    const r = await run(['tools', 'list', '--json']);
    assert.equal(r.code, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.tools.length, 2);
    assert.equal(doc.server.name, 'fake-server');
  });

  test('tools describe returns the input schema', async () => {
    const r = await run(['tools', 'describe', 'echo_tool', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).inputSchema.required, ['text']);
  });

  test('tools describe on an unknown tool exits 1, not 2', async () => {
    const r = await run(['tools', 'describe', 'nope']);
    assert.equal(r.code, 1);
  });
});

describe('generic call with schema coercion', () => {
  test('coerces integers and booleans per the declared schema', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--set', 'count=3', '--set', 'flag=true', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const { echoed } = JSON.parse(r.stdout);
    assert.equal(echoed.text, 'hi');
    assert.equal(echoed.count, 3); // number, not "3"
    assert.equal(echoed.flag, true); // boolean, not "true"
  });

  test('rejects an unknown argument before sending', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--set', 'bogus=1']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument "bogus"/);
  });

  test('rejects a missing required argument', async () => {
    const r = await run(['call', 'strict_tool', '--set', 'alpha=x']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing required argument\(s\): beta/);
  });

  test('rejects a non-integer for an integer field', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--set', 'count=abc']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /expected an integer/);
  });

  test('--dry-run shows the payload without contacting the tool', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--dry-run', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { tool: 'echo_tool', arguments: { text: 'hi' } });
  });
});

describe('transport failure modes', () => {
  test('a hanging server times out with exit 4', async () => {
    const r = await run(['tools', 'list'], { fakeFlags: ['--hang'], timeoutMs: 800 });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /timed out/);
  });

  test('malformed output is a transport error, not a silent timeout', async () => {
    const r = await run(['tools', 'list'], { fakeFlags: ['--garbage'], timeoutMs: 3000 });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /malformed line/);
  });

  test('a server that dies mid-session fails fast with exit 3', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi'], { fakeFlags: ['--die-mid'], timeoutMs: 5000 });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /server exited/);
  });

  test('a JSON-RPC error response maps to exit 3', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi'], { fakeFlags: ['--rpc-error'] });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /tool call rejected/);
  });

  test('isError:true maps to exit 1 and still prints the body', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--json'], { fakeFlags: ['--tool-error'] });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).tool, 'echo_tool');
  });

  test('server stderr is surfaced when something fails', async () => {
    const r = await run(['tools', 'list'], { fakeFlags: ['--noisy-stderr', '--hang'], timeoutMs: 800 });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /fake server starting/);
  });

  test('a reply split mid-UTF-8-character still decodes correctly', async () => {
    const r = await run(['call', 'echo_tool', '--set', 'text=hi', '--json'], { fakeFlags: ['--split-utf8'] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).note, 'café ☕ unicode');
  });

  test('an unexpected response id is ignored rather than mis-resolved', async () => {
    const r = await run(['tools', 'list'], { fakeFlags: ['--wrong-id'], timeoutMs: 800 });
    assert.equal(r.code, 4); // times out; it must never resolve with wrong data
  });
});

describe('argument discipline', () => {
  test('an unknown flag is a usage error', async () => {
    const r = await run(['tools', 'list', '--nope']);
    assert.equal(r.code, 2);
  });

  test('--version prints a semver and exits 0', async () => {
    const r = await run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('--help for a command exits 0 and documents it', async () => {
    const r = await run(['flow', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /BEFORE this command/);
  });

  test('no arguments prints general help with exit 2', async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bounded-intent MCP client/);
  });

  test('a global flag value is never mistaken for the command', async () => {
    // `--db <path>` before the command must not make the path the command.
    const r = await run(['--db', 'scratch/other.db', 'tools', 'list']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /echo_tool/);
  });

  test('--timeout-ms rejects a non-numeric value', async () => {
    const r = await run(['tools', 'list', '--timeout-ms', 'abc']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /positive integer/);
  });
});

describe('validation happens before any server is spawned', () => {
  // The regression that motivates this: a missing flag must cost exit 2,
  // never a transport error from a server that should not have started.
  test('a bad flag with a nonexistent binary still yields usage, not transport', async () => {
    const r = await run(['confirm', '--intent-id', 'abc', '--tx-signature', 'too-short'], {
      env: { SFCLI_BIN: path.join(ROOT, 'does-not-exist.exe') },
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a base58 Solana signature/);
  });

  test('missing required flags never reach the transport layer', async () => {
    const r = await run(['finalize', '--amount', '0.2', '--threshold-bps', '90'], {
      env: { SFCLI_BIN: path.join(ROOT, 'does-not-exist.exe') },
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /draft-hash|draft-id/);
  });
});

describe('domain command validation', () => {
  test('quote rejects an unsupported symbol', async () => {
    const r = await run(['quote', '--amount', '1', '--input', 'DOGE', '--output', 'USDC']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /must each be SOL or USDC/);
  });

  test('quote rejects more precision than the mint has', async () => {
    const r = await run(['quote', '--amount', '0.1234567', '--input', 'USDC', '--output', 'SOL']);
    assert.equal(r.code, 2);
  });

  test('quote rejects slippage above the server policy cap', async () => {
    const r = await run(['quote', '--amount', '1', '--input', 'SOL', '--output', 'USDC', '--slippage-bps', '500']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /1\.\.100/);
  });

  test('propose sends the pinned rail constants', async () => {
    const r = await run(['propose', '--amount', '0.2', '--threshold-bps', '90', '--json']);
    assert.equal(r.code, 1, r.stderr); // fake echoes back, so status !== 'ok'
    const { echoed } = JSON.parse(r.stdout);
    assert.equal(echoed.action, 'deposit');
    assert.equal(echoed.protocol, 'solend');
    assert.equal(echoed.expiry_seconds_after_finalize, 180);
    assert.match(echoed.original_user_message, /above 0\.90%/);
  });

  test('threshold outside 1..10000 is rejected', async () => {
    const r = await run(['propose', '--amount', '0.2', '--threshold-bps', '0']);
    assert.equal(r.code, 2);
  });
});
