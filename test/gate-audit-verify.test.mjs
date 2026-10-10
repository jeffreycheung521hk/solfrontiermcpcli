// T8: `sfcli audit --log` — re-verify a Gate audit log against the ledger.
//
// Logs are written at test time with the real AuditLog writer, transactions
// are built with runtime keys (test/solana-builders.mjs, an encoder that is
// independent of src/solana/tx.mjs), and the ledger is either an injected
// fake `rpc` object or the T7 fake upstream on port 0. No network, no real
// keys, no fixed port.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';

import { AuditLog } from '../src/gate/audit-log.mjs';
import { verifyAuditLog, collectSentTransactions, extractClaims } from '../src/commands/audit.mjs';
import { encode as b58 } from '../src/solana/base58.mjs';
import { keypair, randomAddress, message, transaction, data, SYSTEM } from './solana-builders.mjs';
import { startFakeUpstream } from './fake-upstream-rpc.mjs';
import { CLI, ROOT } from './helpers.mjs';

let dir;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sfgate-audit-verify-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const freshPath = () => {
  const sub = path.join(dir, `log-${++n}`);
  mkdirSync(sub, { recursive: true });
  return path.join(sub, 'sfgate-audit.jsonl');
};

// --- builders -----------------------------------------------------------------

/** A signed legacy SOL transfer from a runtime key: bytes, base64, signature, message hash. */
function buildTx({ lamports = 1_000_000 } = {}) {
  const from = keypair();
  const msg = message({
    header: [1, 0, 1],
    keys: [from.address, randomAddress(), SYSTEM],
    instructions: [{ p: 2, a: [0, 1], d: data.systemTransfer(lamports) }],
  });
  const bytes = transaction(msg, [from]);
  return {
    bytes,
    b64: Buffer.from(bytes).toString('base64'),
    signature: b58(bytes.subarray(1, 65)),
    messageSha256: createHash('sha256').update(msg).digest('hex'),
  };
}

const hex = (bytes) => randomBytes(bytes).toString('hex');
const approvalSignature = () => b58(new Uint8Array(randomBytes(64))); // the approver's, not the tx's

/** The I1 checkpoint flow (SPEC §5.9): wallet.transfer_sol held at the RPC checkpoint. */
function sendFlow(tx, { callId = hex(6), sendId = hex(6), holdId = hex(6), reviewHash = tx.messageSha256 } = {}) {
  return [
    ['tool_call', { callId, tool: 'wallet__transfer_sol', server: 'wallet', decision: 'bound', rule: 'wallet.transfer_sol' }],
    ['tx_review', { sendId, parentIds: [callId], server: 'wallet', messageSha256: reviewHash, summaryLine: '-0.001 SOL', verdict: 'hold', violations: [], warnings: [] }],
    ['hold_created', { holdId, sendId, parentIds: [callId], kind: 'rpc-send' }],
    ['hold_approved', { holdId, sendId, parentIds: [callId], publicKey: randomAddress(), signature: approvalSignature(), method: 'wallet-signature' }],
    ['rpc_send_forwarded', { sendId, signature: tx.signature }],
    ['tool_result', { callId, resultSha256: hex(32), isError: false, signature: tx.signature }],
  ];
}

/** The tool-argument flow: wallet.sign_and_send {transaction} reviewed and held before forwarding. */
function toolArgFlow(tx, { callId = hex(6), holdId = hex(6), reviewHash = tx.messageSha256 } = {}) {
  return [
    ['tool_call', { callId, tool: 'wallet__sign_and_send', server: 'wallet', decision: 'bound', rule: 'wallet.sign_and_send' }],
    ['tx_review', { callId, messageSha256: reviewHash, summaryLine: '-0.001 SOL', verdict: 'hold', violations: [], warnings: [] }],
    ['hold_created', { holdId, callId, kind: 'tool-arg' }],
    ['hold_approved', { holdId, callId, publicKey: randomAddress(), signature: approvalSignature(), method: 'wallet-signature' }],
    ['tool_result', { callId, resultSha256: hex(32), isError: false, signature: tx.signature }],
  ];
}

/** Write a log with the real writer: gate_start, the given records, gate_stop. */
function writeLog(entries, file = freshPath()) {
  const log = AuditLog.open(file);
  log.append('gate_start', { cluster: 'devnet', version: 'test' });
  for (const [type, payload] of entries) log.append(type, payload);
  log.append('gate_stop', { reason: 'stdin closed' });
  return file;
}

const logText = (entries) => readFileSync(writeLog(entries), 'utf8');

/** A getTransaction result as the RPC returns it with encoding base64. */
const landed = (tx, meta = { err: null, fee: 5000 }) => ({
  slot: 4242,
  blockTime: 1760000000,
  meta,
  transaction: [tx.b64, 'base64'],
  version: 'legacy',
});

/** An injected ledger: signature -> result, or an Error to throw. Records every call. */
function fakeRpc(ledger = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method !== 'getTransaction') throw new Error(`unexpected RPC ${method}`);
      const answer = ledger[params[0]];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  };
}

const txRows = (report) => report.results.filter((r) => r.claim.startsWith('tx '));

// --- document mode -------------------------------------------------------------

describe('document mode is unchanged', () => {
  test('extractClaims still finds signatures in an acceptance document', () => {
    const sig = buildTx().signature;
    assert.deepEqual(extractClaims(`| tx | \`${sig}\` |`).signatures, [sig]);
  });
});

// --- chain ---------------------------------------------------------------------

describe('chain', () => {
  test('a generated log verifies: chain · N records · PASS', async () => {
    const tx = buildTx();
    const text = logText(sendFlow(tx));
    const report = await verifyAuditLog({ text, rpc: null });
    assert.deepEqual(report.results[0], {
      claim: 'chain',
      status: 'PASS',
      expected: 'hash-chained from genesis',
      observed: '8 records',
      note: '',
    });
    assert.deepEqual(report.chain, { ok: true, records: 8 });
    assert.equal(report.verdict, 'VERIFIED');
  });

  test('a one-byte edit on any line FAILs at that line', async () => {
    const text = logText(sendFlow(buildTx()));
    const lines = text.split('\n').slice(0, -1);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      // Flip one bit in the middle of line i+1 (ASCII stays ASCII, no newline appears).
      const at = offset + Math.floor(lines[i].length / 2);
      const bytes = Buffer.from(text, 'utf8');
      bytes[at] ^= 0x01;
      const report = await verifyAuditLog({ text: bytes.toString('utf8'), rpc: null });
      assert.equal(report.results[0].status, 'FAIL', `line ${i + 1}`);
      assert.match(report.results[0].observed, new RegExp(`^FAIL at line ${i + 1}: `), `line ${i + 1}`);
      assert.equal(report.chain.firstBadLine, i + 1);
      assert.equal(report.verdict, 'FAILED');
      offset += lines[i].length + 1;
    }
  });

  test('records from the first bad line on are not read', async () => {
    const tx = buildTx();
    const text = logText(sendFlow(tx));
    const lines = text.split('\n');
    // Line 2 (tool_call) edited: the send on line 6 must not be checked at all.
    lines[1] = lines[1].replace('"decision":"bound"', '"decision":"bounD"');
    const rpc = fakeRpc({ [tx.signature]: landed(tx) });
    const report = await verifyAuditLog({ text: lines.join('\n'), rpc });
    assert.equal(report.results[0].status, 'FAIL');
    assert.match(report.results[0].observed, /^FAIL at line 2: hash mismatch/);
    assert.equal(report.results[1].claim, 'records from line 2');
    assert.equal(report.results[1].status, 'UNVERIFIED');
    assert.equal(txRows(report).length, 0);
    assert.equal(rpc.calls.length, 0);
  });

  test('an edit after the send still lets the verified prefix be checked', async () => {
    const tx = buildTx();
    const text = logText(sendFlow(tx));
    const lines = text.split('\n');
    lines[7] = lines[7].replace('stdin closed', 'stdin closeD'); // gate_stop
    const report = await verifyAuditLog({ text: lines.join('\n'), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.match(report.results[0].observed, /^FAIL at line 8: /);
    assert.equal(txRows(report)[0].status, 'PASS');
    assert.equal(report.verdict, 'FAILED');
  });

  test('CRLF line endings (git autocrlf checkout) still verify, and are reported', async () => {
    const tx = buildTx();
    const text = logText(sendFlow(tx)).replace(/\n/g, '\r\n');
    const report = await verifyAuditLog({ text, rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.equal(report.results[0].status, 'PASS');
    assert.equal(report.crlf, true);
    assert.equal(txRows(report)[0].status, 'PASS');
    // A lone CR inside a line is still an edit.
    const lone = logText(sendFlow(tx)).replace('"tool_call"', '"tool_call"\r');
    assert.equal((await verifyAuditLog({ text: lone, rpc: null })).results[0].status, 'FAIL');
  });
});

// --- ledger re-derivation ------------------------------------------------------

describe('ledger re-derivation with an injected fake RPC', () => {
  test('matching message, err null ⇒ PASS; the tool result with the same signature is reported once', async () => {
    const tx = buildTx();
    const rpc = fakeRpc({ [tx.signature]: landed(tx) });
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc });
    const rows = txRows(report);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'PASS', rows[0].observed);
    assert.equal(rows[0].observed, 'slot 4242 · message matches · err null');
    assert.equal(rows[0].signature, tx.signature);
    assert.deepEqual(rows[0].approvedMessageSha256, [tx.messageSha256]);
    assert.equal(rows[0].observedMessageSha256, tx.messageSha256);
    assert.deepEqual(rows[0].lines, [6, 7]);
    assert.equal(rpc.calls.length, 1);
    assert.deepEqual(rpc.calls[0], {
      method: 'getTransaction',
      params: [tx.signature, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'finalized' }],
    });
    assert.equal(report.verdict, 'VERIFIED');
    assert.deepEqual(report.counts, { passed: 2, failed: 0, unverified: 0 });
    assert.doesNotThrow(() => JSON.stringify(report));
  });

  test('--commitment confirmed is passed through', async () => {
    const tx = buildTx();
    const rpc = fakeRpc({ [tx.signature]: landed(tx) });
    await verifyAuditLog({ text: logText(sendFlow(tx)), rpc, commitment: 'confirmed' });
    assert.equal(rpc.calls[0].params[1].commitment, 'confirmed');
  });

  test('tool-argument review (callId link, no checkpoint send) ⇒ PASS', async () => {
    const tx = buildTx();
    const report = await verifyAuditLog({ text: logText(toolArgFlow(tx)), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    const [row] = txRows(report);
    assert.equal(row.status, 'PASS', row.observed);
    assert.deepEqual(row.callIds.length, 1);
  });

  test('different message on chain ⇒ FAIL', async () => {
    // The human approved message A; the transaction that landed under the
    // logged signature carries message B (what a server posting its own
    // transaction elsewhere would look like).
    const approved = buildTx();
    const other = buildTx();
    const text = logText(toolArgFlow(other, { reviewHash: approved.messageSha256 }));
    const report = await verifyAuditLog({ text, rpc: fakeRpc({ [other.signature]: landed(other) }) });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.match(row.observed, /message [0-9a-f]{12}… ≠ approved/);
    assert.equal(row.observedMessageSha256, other.messageSha256);
    assert.equal(report.verdict, 'FAILED');
  });

  test('meta.err ⇒ FAIL', async () => {
    const tx = buildTx();
    const err = { InstructionError: [0, { Custom: 1 }] };
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({ [tx.signature]: landed(tx, { err, fee: 5000 }) }) });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.match(row.observed, /err \{"InstructionError":\[0,\{"Custom":1\}\]\}/);
  });

  test('missing status metadata ⇒ FAIL (success cannot be shown)', async () => {
    const tx = buildTx();
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({ [tx.signature]: landed(tx, null) }) });
    assert.equal(txRows(report)[0].status, 'FAIL');
  });

  test('missing on chain ⇒ FAIL', async () => {
    const tx = buildTx();
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({}) });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.equal(row.observed, 'not found at finalized');
  });

  test('an RPC error ⇒ FAIL, never a pass', async () => {
    const tx = buildTx();
    const report = await verifyAuditLog({
      text: logText(sendFlow(tx)),
      rpc: fakeRpc({ [tx.signature]: new Error('socket hang up') }),
    });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.equal(row.observed, 'getTransaction failed: socket hang up');
  });

  test('an RPC that answers with a different transaction ⇒ FAIL', async () => {
    const tx = buildTx();
    const other = buildTx();
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({ [tx.signature]: landed(other) }) });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.match(row.observed, /different transaction/);
  });

  test('ledger bytes that do not decode ⇒ FAIL', async () => {
    const tx = buildTx();
    const broken = { ...landed(tx), transaction: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'] };
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({ [tx.signature]: broken }) });
    assert.equal(txRows(report)[0].status, 'FAIL');
    assert.match(txRows(report)[0].observed, /does not decode/);
    const parsed = { ...landed(tx), transaction: { message: {}, signatures: [tx.signature] } }; // jsonParsed shape
    const report2 = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: fakeRpc({ [tx.signature]: parsed }) });
    assert.equal(txRows(report2)[0].status, 'FAIL');
  });

  test('no RPC ⇒ UNVERIFIED, which is reported but does not fail the audit', async () => {
    const tx = buildTx();
    const report = await verifyAuditLog({ text: logText(sendFlow(tx)), rpc: null, rpcHint: 'no RPC (set SFGATE_UPSTREAM_RPC_URL)' });
    const [row] = txRows(report);
    assert.equal(row.status, 'UNVERIFIED');
    assert.equal(row.observed, 'not checked: no RPC (set SFGATE_UPSTREAM_RPC_URL)');
    assert.equal(report.verdict, 'VERIFIED');
    assert.deepEqual(report.counts, { passed: 1, failed: 0, unverified: 1 });
  });

  test('every distinct signature is checked once, in log order', async () => {
    const a = buildTx();
    const b = buildTx();
    const rpc = fakeRpc({ [a.signature]: landed(a), [b.signature]: landed(b) });
    const report = await verifyAuditLog({ text: logText([...sendFlow(a), ...toolArgFlow(b)]), rpc });
    assert.deepEqual(txRows(report).map((r) => [r.signature, r.status]), [[a.signature, 'PASS'], [b.signature, 'PASS']]);
    assert.equal(rpc.calls.length, 2);
  });
});

// --- linking signatures to approvals --------------------------------------------

describe('linking a signature to the approved message', () => {
  test('a tool result with a signature Gate never reviewed ⇒ UNVERIFIED, and no RPC call', async () => {
    const tx = buildTx();
    const callId = hex(6);
    const entries = [
      ['tool_call', { callId, tool: 'jup__execute', server: 'jup', decision: 'pass', rule: 'jup.execute' }],
      ['tool_result', { callId, resultSha256: hex(32), isError: false, signature: tx.signature }],
    ];
    const rpc = fakeRpc({ [tx.signature]: landed(tx) });
    const report = await verifyAuditLog({ text: logText(entries), rpc });
    const [row] = txRows(report);
    assert.equal(row.status, 'UNVERIFIED');
    assert.match(row.observed, /never reviewed/);
    assert.equal(rpc.calls.length, 0);
    assert.equal(report.verdict, 'VERIFIED');
  });

  test('a later call that only mentions a forwarded signature does not add a row', async () => {
    const tx = buildTx();
    const status = hex(6);
    const entries = [
      ...sendFlow(tx),
      ['tool_call', { callId: status, tool: 'wallet__get_status', server: 'wallet', decision: 'pass', rule: 'wallet.get_status' }],
      ['tool_result', { callId: status, resultSha256: hex(32), isError: false, signature: tx.signature }],
    ];
    const report = await verifyAuditLog({ text: logText(entries), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.equal(txRows(report).length, 1);
    assert.equal(txRows(report)[0].status, 'PASS');
  });

  test('a send forwarded with no approval on record ⇒ FAIL, even without an RPC (I2)', async () => {
    const tx = buildTx();
    const entries = sendFlow(tx).filter(([type]) => type !== 'hold_approved');
    const report = await verifyAuditLog({ text: logText(entries), rpc: null });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.match(row.observed, /no approval on record .*\(I2\)/);
    assert.equal(report.verdict, 'FAILED');
  });

  test('a send whose hold was rejected, not approved ⇒ FAIL', async () => {
    const tx = buildTx();
    const entries = sendFlow(tx).map(([type, payload]) =>
      type === 'hold_approved' ? ['hold_rejected', { holdId: payload.holdId, sendId: payload.sendId, reason: 'user' }] : [type, payload]);
    const report = await verifyAuditLog({ text: logText(entries), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.equal(txRows(report)[0].status, 'FAIL');
  });

  test('an approval logged after the forward ⇒ FAIL (I6)', async () => {
    const tx = buildTx();
    const flow = sendFlow(tx);
    const approval = flow.find(([type]) => type === 'hold_approved');
    const entries = [...flow.filter((e) => e !== approval), approval];
    const report = await verifyAuditLog({ text: logText(entries), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    const [row] = txRows(report);
    assert.equal(row.status, 'FAIL');
    assert.match(row.observed, /logged after line/);
  });

  test('a review with verdict "deny" cannot back an approval', async () => {
    const tx = buildTx();
    const entries = toolArgFlow(tx).map(([type, payload]) =>
      type === 'tx_review' ? [type, { ...payload, verdict: 'deny' }] : [type, payload]);
    const report = await verifyAuditLog({ text: logText(entries), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.equal(txRows(report)[0].status, 'FAIL');
  });

  test('two held reviews under one id: ambiguous ⇒ FAIL, unless the hold states its hash', async () => {
    const tx = buildTx();
    const decoy = buildTx();
    const callId = hex(6);
    const holdId = hex(6);
    const base = toolArgFlow(tx, { callId, holdId });
    const withDecoy = [
      base[0],
      ['tx_review', { callId, messageSha256: decoy.messageSha256, summaryLine: 'x', verdict: 'hold', violations: [], warnings: [] }],
      ...base.slice(1),
    ];
    const ledger = { [tx.signature]: landed(tx) };
    const ambiguous = await verifyAuditLog({ text: logText(withDecoy), rpc: fakeRpc(ledger) });
    assert.equal(txRows(ambiguous)[0].status, 'FAIL');
    assert.match(txRows(ambiguous)[0].observed, /does not say which was approved/);

    const stated = withDecoy.map(([type, payload]) =>
      type === 'hold_created' ? [type, { ...payload, messageSha256: tx.messageSha256 }] : [type, payload]);
    const resolved = await verifyAuditLog({ text: logText(stated), rpc: fakeRpc(ledger) });
    assert.equal(txRows(resolved)[0].status, 'PASS', txRows(resolved)[0].observed);

    const statedDecoy = withDecoy.map(([type, payload]) =>
      type === 'hold_approved' ? [type, { ...payload, messageSha256: decoy.messageSha256 }] : [type, payload]);
    const wrong = await verifyAuditLog({ text: logText(statedDecoy), rpc: fakeRpc(ledger) });
    assert.equal(txRows(wrong)[0].status, 'FAIL');
    assert.match(txRows(wrong)[0].observed, /≠ approved/);
  });

  test('hold records that disagree on the hash ⇒ FAIL', async () => {
    const tx = buildTx();
    const entries = toolArgFlow(tx).map(([type, payload]) => {
      if (type === 'hold_created') return [type, { ...payload, messageSha256: tx.messageSha256 }];
      if (type === 'hold_approved') return [type, { ...payload, messageSha256: buildTx().messageSha256 }];
      return [type, payload];
    });
    const report = await verifyAuditLog({ text: logText(entries), rpc: fakeRpc({ [tx.signature]: landed(tx) }) });
    assert.match(txRows(report)[0].observed, /disagree/);
    assert.equal(txRows(report)[0].status, 'FAIL');
  });

  test('a malformed signature: FAIL when Gate forwarded it, UNVERIFIED when a tool result carried it', () => {
    const tx = buildTx();
    const forwarded = sendFlow(tx).map(([type, payload]) =>
      type === 'rpc_send_forwarded' ? [type, { ...payload, signature: 'not-a-signature' }] : [type, payload])
      .filter(([type]) => type !== 'tool_result');
    const records = (entries) => logText(entries).trim().split('\n').map((l) => JSON.parse(l));
    const [sent] = collectSentTransactions(records(forwarded));
    assert.equal(sent.link, 'broken');

    const callId = hex(6);
    const [fromTool] = collectSentTransactions(records([
      ['tool_result', { callId, isError: false, signature: '1'.repeat(88) }],
    ]));
    assert.equal(fromTool.link, 'malformed');
  });

  test('rpc_send_forwarded without a sendId or a signature ⇒ FAIL', async () => {
    const tx = buildTx();
    const noSendId = sendFlow(tx).map(([type, payload]) =>
      type === 'rpc_send_forwarded' ? [type, { signature: payload.signature }] : [type, payload]);
    assert.equal(txRows(await verifyAuditLog({ text: logText(noSendId), rpc: null }))[0].status, 'FAIL');
    const noSig = sendFlow(tx).map(([type, payload]) =>
      type === 'rpc_send_forwarded' ? [type, { sendId: payload.sendId }] : [type, payload]);
    const rows = txRows(await verifyAuditLog({ text: logText(noSig), rpc: null }));
    assert.equal(rows[0].status, 'FAIL');
  });

  test('the approver signature in hold_approved is never mistaken for a transaction', () => {
    const tx = buildTx();
    const recs = logText(sendFlow(tx)).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(collectSentTransactions(recs).map((g) => g.signature), [tx.signature]);
  });
});

// --- the command ----------------------------------------------------------------

/** Run the CLI hermetically: no inherited RPC URL, no colour. */
function cli(args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...env };
  for (const name of ['SFGATE_UPSTREAM_RPC_URL', 'SOLFRONTIER_RPC_URL', 'SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR']) {
    if (!(name in env)) delete childEnv[name];
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

/** A loopback URL carrying a runtime "API key" in both query and path, as a hosted RPC would. */
function secretUrl(base) {
  const token = hex(16);
  return { url: `${base}/v2/${token}?api-key=${token}`, token };
}

describe('sfcli audit --log', () => {
  let upstream;
  let good;
  let failed;
  before(async () => {
    good = buildTx();
    failed = buildTx();
    upstream = await startFakeUpstream({
      transactions: {
        [good.signature]: landed(good),
        [failed.signature]: landed(failed, { err: { InstructionError: [0, 'Custom'] }, fee: 5000 }),
      },
    });
  });
  after(() => upstream?.close());

  test('chain only when SFGATE_UPSTREAM_RPC_URL is unset: exit 0, rows PASS and UNVERIFIED', async () => {
    const file = writeLog(sendFlow(good));
    const r = await cli(['audit', '--log', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /chain only \(SFGATE_UPSTREAM_RPC_URL is not set\)/);
    assert.match(r.stderr, /PASS +chain +hash-chained from genesis +8 records/);
    assert.match(r.stderr, /UNVER +tx /);
    assert.match(r.stderr, /VERIFIED/);
  });

  test('--json prints one JSON document with the rows', async () => {
    const file = writeLog(sendFlow(good));
    const r = await cli(['audit', '--log', file, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.verdict, 'VERIFIED');
    assert.equal(doc.rpc, null);
    assert.deepEqual(doc.chain, { ok: true, records: 8 });
    assert.deepEqual(doc.results.map((x) => x.status), ['PASS', 'UNVERIFIED']);
    assert.equal(doc.results[1].signature, good.signature);
  });

  test('a one-byte edit: exit 1 and the line is named', async () => {
    const file = writeLog(sendFlow(good));
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[2] = lines[2].replace('"verdict":"hold"', '"verdict":"holD"'); // tx_review on line 3
    assert.match(lines[2], /"holD"/);
    writeFileSync(file, lines.join('\n'));
    const r = await cli(['audit', '--log', file]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /FAIL +chain +hash-chained from genesis +FAIL at line 3: hash mismatch/);
    assert.match(r.stderr, /FAILED/);
  });

  test('against the fake upstream: PASS exit 0, and the URL never appears (I4)', async () => {
    const { url, token } = secretUrl(upstream.url);
    const file = writeLog(sendFlow(good));
    for (const mode of [[], ['--json']]) {
      const r = await cli(['audit', '--log', file, '--commitment', 'confirmed', ...mode], { SFGATE_UPSTREAM_RPC_URL: url });
      assert.equal(r.code, 0, r.stderr);
      const out = r.stdout + r.stderr;
      assert.ok(!out.includes(token) && !out.includes(upstream.url), 'no RPC URL or key in any output');
      if (mode.length) assert.equal(JSON.parse(r.stdout).results[1].status, 'PASS');
      else assert.match(r.stderr, /PASS +tx .*slot 4242 · message matches · err null/);
    }
    const call = upstream.calls.find((c) => c.method === 'getTransaction' && c.params[0] === good.signature);
    assert.deepEqual(call.params[1], { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  });

  test('--rpc-env names another variable; a failed transaction exits 1', async () => {
    const { url, token } = secretUrl(upstream.url);
    const file = writeLog([...sendFlow(good), ...toolArgFlow(failed)]);
    const r = await cli(['audit', '--log', file, '--rpc-env', 'MY_GATE_RPC', '--json'], { MY_GATE_RPC: url });
    assert.equal(r.code, 1, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.rpc, { env: 'MY_GATE_RPC', commitment: 'finalized' });
    assert.deepEqual(doc.results.map((x) => x.status), ['PASS', 'PASS', 'FAIL']);
    assert.ok(!(r.stdout + r.stderr).includes(token));
  });

  test('RPC failures are FAIL rows with the URL scrubbed (unreachable and unparsable URLs)', async () => {
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    const file = writeLog(sendFlow(good));
    for (const { url, token } of [secretUrl(`http://127.0.0.1:${port}`), { url: `notaurl-${hex(16)}`, token: null }]) {
      const r = await cli(['audit', '--log', file, '--json'], { SFGATE_UPSTREAM_RPC_URL: url });
      assert.equal(r.code, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).results[1].status, 'FAIL');
      const out = r.stdout + r.stderr;
      assert.ok(!out.includes(url), 'URL scrubbed');
      if (token) assert.ok(!out.includes(token), 'key scrubbed');
    }
  });

  test('usage errors exit 2 before any RPC: bad commitment, both modes, missing file, empty file', async () => {
    const file = writeLog(sendFlow(good));
    const empty = freshPath();
    writeFileSync(empty, '');
    for (const args of [
      ['audit', '--log', file, '--commitment', 'processed'],
      ['audit', 'doc.md', '--log', file],
      ['audit', '--log', path.join(dir, 'nope.jsonl')],
      ['audit', '--log', empty],
      ['audit', 'doc.md', '--rpc-env', 'X'],
    ]) {
      const r = await cli(args);
      assert.equal(r.code, 2, `${args.join(' ')}\n${r.stderr}`);
    }
  });

  test('--rpc-env given a URL instead of a name: exit 2 without echoing it', async () => {
    const { url, token } = secretUrl('https://rpc.example.invalid');
    const file = writeLog(sendFlow(good));
    const r = await cli(['audit', '--log', file, '--rpc-env', url]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /takes the NAME of an environment variable/);
    assert.ok(!r.stderr.includes(token) && !r.stdout.includes(token));
  });

  test('--rpc-env naming an unset variable is refused, not downgraded to chain-only', async () => {
    const file = writeLog(sendFlow(good));
    const r = await cli(['audit', '--log', file, '--rpc-env', 'SFGATE_T8_UNSET_FOR_TEST']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /SFGATE_T8_UNSET_FOR_TEST is not set/);
  });
});
