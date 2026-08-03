// The zero-fund demonstration must stay zero-fund.
//
// showcase.mjs checks the argv of every command it spawns against a forbidden
// list, so that editing a stage cannot quietly turn a demo into a run that
// spends money. That guard is a safety mechanism, so it gets a positive control
// in both directions -- a list that blocks nothing and a list that blocks
// everything would both look fine by inspection.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from './helpers.mjs';

const SHOWCASE = path.join(ROOT, 'scripts', 'demo', 'showcase.mjs');
const src = readFileSync(SHOWCASE, 'utf8');

/** The literal FORBIDDEN list as the script will actually evaluate it. */
function forbiddenRules() {
  const m = src.match(/const FORBIDDEN = \[(.*?)\];/s);
  assert.ok(m, 'showcase.mjs must declare a FORBIDDEN list');
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.match(/^\/(.*)\/([a-z]*)$/);
      assert.ok(parts, `FORBIDDEN entries must be regex literals, saw: ${s}`);
      return new RegExp(parts[1], parts[2]);
    });
}

describe('the demonstration cannot be turned into a funded run', () => {
  test('every argument that could move money is blocked', () => {
    const rules = forbiddenRules();
    // --user-wallet is the one that matters most: with it, `flow --dry-run`
    // performs a real finalize, writes a row, starts the 180s clock and prints
    // a signable URL.
    for (const arg of ['--user-wallet', 'watch', '--execute', '--yes']) {
      assert.ok(rules.some((r) => r.test(arg)), `${arg} must be blocked`);
    }
  });

  test('the arguments the demo actually uses are not blocked', () => {
    // Without this half, a FORBIDDEN list of /./ would pass the test above and
    // the demo would abort on its first stage.
    const rules = forbiddenRules();
    for (const arg of [
      'tools', 'list', 'doctor', 'audit', 'flow', '--dry-run',
      '--threshold-bps', '9999', '--amount', '0.2', '--version',
    ]) {
      assert.ok(!rules.some((r) => r.test(arg)), `${arg} must NOT be blocked`);
    }
  });

  test('no stage passes a wallet, a keypair or the executor', () => {
    // Belt and braces over the source itself: the guard runs at spawn time, but
    // an argument that never reaches runCli would slip past it.
    for (const forbidden of ['--user-wallet', '--execute']) {
      const inCall = new RegExp(`runCli\\([^)]*${forbidden.replace(/-/g, '\\-')}`, 's');
      assert.ok(!inCall.test(src), `no runCli call may contain ${forbidden}`);
    }
  });

  test('stages assert an exact exit code, not merely a non-zero one', () => {
    // The regression: an earlier draft used a boolean expectFailure, so when
    // the entry-point path was wrong every stage died with exit 1 and the two
    // refusal stages reported themselves green while proving nothing.
    //
    // The check is for expectFailure as CODE -- as a parameter, an assignment
    // or a test -- not as the word. Written loosely it matched the comment in
    // showcase.mjs that explains this very defect, which would have made the
    // only way to pass be to stop recording why the rule exists.
    assert.ok(
      !/expectFailure\s*[:=?)]/.test(src),
      'expectFailure must not come back as a parameter or predicate',
    );
    assert.match(src, /const ok = code === expect;/);
    assert.match(src, /expect: EXIT_FAILED/, 'the refusal stages must name the code they want');
  });

  test('the demo exits non-zero when a stage produces the wrong code', () => {
    // A demonstration that cannot fail is a slideshow.
    assert.match(src, /if \(failures > 0\)/);
    assert.match(src, /process\.exit\(1\)/);
  });

  test('it refuses to run in a shell holding the signing key', () => {
    assert.match(src, /SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR/);
    assert.match(src, /ABORT: SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR is set/);
  });

  test('the entry point it spawns exists', () => {
    // The defect that made the first run useless: it spawned src/cli.mjs, which
    // is not this project's entry point.
    const m = src.match(/const CLI = path\.join\(ROOT, 'src', '([^']+)'\)/);
    assert.ok(m, 'showcase.mjs must resolve a CLI entry point');
    assert.doesNotThrow(() => readFileSync(path.join(ROOT, 'src', m[1])));
  });

  test('the script is pure ASCII', () => {
    // Same gate as the PowerShell harness, for the same reason: a stray
    // typographic character is invisible in review and fatal at runtime.
    const bytes = readFileSync(SHOWCASE);
    const high = [...bytes].filter((b) => b > 127);
    assert.equal(high.length, 0, `${high.length} non-ASCII byte(s)`);
  });
});
