// Local manual-signing prototype. It never loads a wallet key or spawns a wallet MCP.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { PAGE_HTML, APP_JS } from './phantom-keyless-page.mjs';
import { createKeylessRuntime, WALLET, APPROVER } from './phantom-keyless-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The saved three-order measurement had only 19.968 s remaining at receipt.
// Use a conservative local cutoff and reserve relay time. The runtime also
// caps every hold at the same absolute deadline; payment never starts a new clock.
export const ORDER_LIFETIME_MS = 20000;
export const EXECUTION_RESERVE_MS = 2000;
export const APPROVAL_TIMEOUT_SEC = 12;
export const BLOCKHASH_POLL_MS = 1000;
export function timingForProfile(mode = 'two-profiles') {
  if (!['two-profiles', 'same-profile'].includes(mode)) throw new Error('Unknown wallet profile mode');
  return { profileMode: mode, maxPaymentAgeMs: mode === 'same-profile' ? 8000 : 12000,
    signStartLimitMs: mode === 'same-profile' ? 5000 : 9000 };
}
const repo = path.resolve(here, '../../..');
const stateDirectory = path.join(repo, '.sfgate-phantom-state');
const policyFile = path.join(repo, 'docs/proof/mainnet-2026-10-12/policy.json');
const { loadGateConfig, createRedactor } = await import(pathToFileURL(path.join(repo, 'src/gate/config.mjs')));
const { AuditLog, verifyChainText } = await import(pathToFileURL(path.join(repo, 'src/gate/audit-log.mjs')));
const { HoldQueue } = await import(pathToFileURL(path.join(repo, 'src/gate/holds.mjs')));
const { startApprovalServer, CSP } = await import(pathToFileURL(path.join(repo, 'src/gate/approval-server.mjs')));
const { SolanaRpc } = await import(pathToFileURL(path.join(repo, 'src/solana/rpc.mjs')));
const { compileToolPolicy } = await import(pathToFileURL(path.join(repo, 'src/gate/tool-policy.mjs')));
const { compileTxPolicy } = await import(pathToFileURL(path.join(repo, 'src/gate/tx-policy.mjs')));

/** Create machine-local public configuration without reading a wallet or RPC credential. */
export function prepareConfig({ directory = stateDirectory } = {}) {
  const raw = JSON.parse(readFileSync(policyFile, 'utf8'));
  delete raw.pettyCash;
  raw.servers = { jup: { command: process.execPath, timeoutMs: 120000 } };
  raw.tools = { 'jup.execute-ultra-order': { mode: 'bound', txArg: 'transaction', txArgEncoding: 'base64' }, '*': 'deny' };
  raw.audit.path = path.join(path.resolve(directory), 'mainnet-phantom-keyless-audit.jsonl');
  raw.approval = { ...raw.approval, timeoutSec: APPROVAL_TIMEOUT_SEC };
  raw._comment = 'Local prototype using Gate pipeline with a public wallet address. No wallet file is loaded, no downstream process or walletVar is used. Starts paused; only signed bytes can reach Jupiter after Gate approval.';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(path.resolve(directory), 'phantom-keyless.runtime.json');
  writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  // Validate the environment-variable name with a public, unused placeholder.
  // The RPC credential is loaded lazily only by the injected RPC client below.
  const config = loadGateConfig(target, { [raw.upstreamRpcEnv]: 'https://api.mainnet-beta.solana.com' });
  compileToolPolicy(config);
  compileTxPolicy(config.tx, config.lists);
  if (config.cluster !== 'mainnet-beta' || config.approver !== APPROVER || config.tx.maxOutflow.SOL !== 0.003
    || config.approval.timeoutSec !== APPROVAL_TIMEOUT_SEC) throw new Error('Unexpected manual-signing policy');
  return { config, target };
}

export async function startLocalServer({ runtime, sessionToken, port = 8788, web3Path }) {
  const library = readFileSync(web3Path);
  const server = createServer(async (req, res) => {
    const actual = server.address().port;
    const ownOrigin = `http://127.0.0.1:${actual}`;
    const hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
    const origins = new Set([ownOrigin, `http://localhost:${actual}`]);
    const reply = (status, body, type = 'application/json') => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'content-type': type,
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    let pathname = null;
    try {
      if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) return reply(403, { error: '此請求來源不被允許。' });
      pathname = new URL(req.url, ownOrigin).pathname;
      if (req.method === 'GET' && pathname === '/') return reply(200, PAGE_HTML, 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/app.js') return reply(200, APP_JS, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && pathname === '/solana-web3.js') return reply(200, library, 'text/javascript; charset=utf-8');
      if (req.headers['x-sfgate-session'] !== sessionToken) return reply(403, { error: '請使用本次完整的本地連結。' });
      if (req.method === 'GET' && pathname === '/api/state') return reply(200, runtime.state());
      if (req.method !== 'POST' || !['/api/order', '/api/signature', '/api/cancel'].includes(pathname)) return reply(404, { error: '找不到此操作。' });
      if (!origins.has(req.headers.origin) || req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(403, { error: '操作必須由本地頁面送出。' });
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 16384) throw new Error('請求太大。');
      }
      const body = JSON.parse(text || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('請求格式不正確。');
      if (pathname === '/api/order') {
        if (Object.keys(body).length) throw new Error('此測試不接受自訂交換參數。');
        await runtime.quote();
        return reply(200, runtime.state());
      }
      if (pathname === '/api/cancel') {
        runtime.pause();
        return reply(200, runtime.state());
      }
      if (Object.keys(body).some(key => !['id', 'signedTransaction'].includes(key))) throw new Error('簽署請求包含額外欄位。');
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', cancel);
      try {
        const result = await runtime.submit(body, controller.signal);
        return reply(200, result);
      } finally { res.off('close', cancel); }
    } catch (error) {
      const messages = {
        payment_signature_too_late: '付款簽名送到時已超過時限，沒有建立 Gate 核准。請手動重新取得報價。',
        approval_window_expired: '簽署與核准的安全期限已到，這筆交易沒有送出。請手動重新取得報價。',
        order_expired: '報價期限已到，這筆交易沒有送出。請手動重新取得報價。',
        blockhash_expired: '鏈上已確認這份交易的有效期結束，這筆交易沒有送出。請手動重新取得報價。',
      };
      if (pathname === '/api/signature' && Object.hasOwn(messages, error?.message ?? '')
        && runtime.state().canRequote === true) {
        return reply(400, { error: messages[error.message], code: error.message, canRequote: true });
      }
      // Keep provider URLs and payload fragments out of browser error messages.
      return reply(400, { error: '操作未完成。請查看頁面狀態或本地紀錄；不要重複送出。' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/#session=${sessionToken}`, server,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function main() {
  const { config, target } = prepareConfig();
  if (process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({ prepared: true, config: target, wallet: WALLET, approver: APPROVER, paused: true, networkRequests: 0, walletSecretsLoaded: 0 }));
    return;
  }
  // The optional browser bridge is supplied by the operator, never downloaded
  // or installed by Gate. Keep the core dependency-free and record this demo
  // prerequisite explicitly rather than hiding a package inside the repo.
  const web3Path = process.env.SFGATE_BROWSER_WEB3_PATH;
  if (!web3Path || !existsSync(web3Path)) {
    console.error('Set SFGATE_BROWSER_WEB3_PATH to the local browser bundle used by Phantom signing.');
    process.exitCode = 1;
    return;
  }
  if (existsSync(config.audit.path)) {
    const text = readFileSync(config.audit.path, 'utf8');
    if (!verifyChainText(text).ok) throw new Error('Existing audit chain must be repaired before startup');
    if (text.split('\n').filter(Boolean).some(line => JSON.parse(line).type === 'execute_attempt')) throw new Error('A previous submission must be reconciled before another run');
  }
  let rpcClient;
  let scrub = text => String(text);
  const rpc = { async call(method, params) {
    if (!rpcClient) {
      const rpcFile = path.join(homedir(), '.sfgate/mainnet-rpc.url');
      const endpoint = existsSync(rpcFile) ? readFileSync(rpcFile, 'utf8').trim()
        : process.env.SFGATE_UPSTREAM_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC endpoint format is invalid');
      scrub = createRedactor([endpoint]);
      rpcClient = new SolanaRpc({ url: endpoint, timeoutMs: 25000 });
    }
    return rpcClient.call(method, params);
  } };
  const audit = AuditLog.open(config.audit.path, { redact: text => scrub(text) });
  audit.append('gate_start', { pid: process.pid, cluster: config.cluster, servers: ['jup'], wallet: WALLET, approver: APPROVER, runtime: 'public-wallet manual-signing prototype', paused: true });
  const holds = new HoldQueue({ approver: APPROVER });
  let approval, local, runtime;
  try {
    approval = await startApprovalServer({ holds, approver: APPROVER, ...config.approval, cluster: config.cluster });
    const transport = {
      async order(params) {
        const response = await fetch(`https://api.jup.ag/ultra/v1/order?${new URLSearchParams(params)}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Jupiter order HTTP ${response.status}`);
        return response.json();
      },
      async execute(body) {
        const response = await fetch('https://api.jup.ag/ultra/v1/execute', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Jupiter execute HTTP ${response.status}`);
        return response.json();
      },
    };
    const timing = timingForProfile(process.argv.includes('--same-profile') ? 'same-profile' : 'two-profiles');
    runtime = createKeylessRuntime({ config, rpc, transport, audit, holds, approvalUrl: approval.url,
      blockhashPollMs: BLOCKHASH_POLL_MS, orderLifetimeMs: ORDER_LIFETIME_MS,
      executionReserveMs: EXECUTION_RESERVE_MS,
      maxPaymentAgeMs: timing.maxPaymentAgeMs, signStartLimitMs: timing.signStartLimitMs });
    local = await startLocalServer({ runtime, sessionToken: randomBytes(24).toString('hex'),
      web3Path });
    console.log(JSON.stringify({ event: 'READY_PAUSED', signingUrl: local.url, approvalUrl: approval.url, wallet: WALLET, amountSol: '0.001', walletSecretsLoaded: 0,
      orderLifetimeMs: ORDER_LIFETIME_MS, executionReserveMs: EXECUTION_RESERVE_MS,
      sharedApprovalWindowMs: ORDER_LIFETIME_MS - EXECUTION_RESERVE_MS, ...timing }));
    const input = createInterface({ input: process.stdin, terminal: false });
    for await (const line of input) {
      const command = line.trim();
      if (command === 'quit') { input.close(); break; }
      if (command === 'resume') runtime.resume();
      else if (command === 'pause') runtime.pause();
      else if (command !== 'status') { console.log(JSON.stringify({ event: 'UNKNOWN_COMMAND' })); continue; }
      const state = runtime.state();
      console.log(JSON.stringify({ event: 'STATUS', paused: state.paused, phase: state.phase, result: state.result, pendingHolds: holds.listPending().map(hold => ({ id: hold.id, summaryLine: hold.review.summaryLine })) }));
    }
  } finally {
    await runtime?.close();
    await local?.close();
    holds.close();
    await approval?.close();
    audit.append('gate_stop', { reason: 'local manual-signing prototype closed' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Manual-signing setup failed; no automatic retry.'); process.exitCode = 1; });
}
