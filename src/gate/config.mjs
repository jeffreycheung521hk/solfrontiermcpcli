// Gate configuration: load, validate, freeze (SPEC §5.1).
//
// Everything here runs before any process is spawned, so every mistake costs
// an exit 2 and nothing else. The rules mirror src/config.mjs: guardrails in
// code, not in a README, and honest about being defence against operator
// mistakes rather than a security boundary.
//
// Secrets never live on the returned object. The config names environment
// variables; the upstream URL is read from the environment only when asked
// for (resolveUpstream) and the petty-cash key only when loaded
// (loadPettyCash), and neither ever appears in an error message.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { GuardrailError, UsageError } from '../cli/exit-codes.mjs';
import { encode as base58Encode, decode as base58Decode } from '../solana/base58.mjs';

// Keep T1's public names for callers while sharing the Solana codec.
export { base58Encode, base58Decode };

const SECRET_KEY_RE = /rpc.?url|api.?key|secret|keypair|mnemonic|private|seed/i;
const SERVER_NAME_RE = /^[a-z0-9-]{1,16}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CLUSTERS = ['devnet', 'mainnet-beta', 'localnet'];
const WALLET_FORMATS = ['base58-64', 'json-array'];
const APPROVAL_METHODS = ['wallet-signature', 'local-button'];

const TOP_LEVEL_KEYS = new Set([
  'cluster', 'upstreamRpcEnv', 'upstreamWsEnv', 'pettyCash', 'approver', 'servers', 'lists', 'tools',
  'tx', 'approval', 'rpcCheckpoint', 'audit', 'showDeniedTools',
]);
const SERVER_KEYS = new Set(['command', 'args', 'cwd', 'rpcVar', 'walletVar', 'walletFormat', 'env', 'timeoutMs']);
const APPROVAL_KEYS = new Set(['method', 'port', 'timeoutSec', 'openBrowser', 'notify']);

export const GATE_DEFAULTS = Object.freeze({
  serverTimeoutMs: 90000,
  approvalTimeoutSec: 40,
  approvalTimeoutSecMax: 60,
  approvalPort: 8787,
  checkpointPort: 18899,
  // Discard port: before the checkpoint exists (pre-I1) every RPC call a
  // downstream makes fails instead of reaching anything real.
  placeholderRpcUrl: 'http://127.0.0.1:9',
});

// --- helpers ---------------------------------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Comments are keys that start with `_`, at any depth. */
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('_')) continue;
    out[k] = stripComments(v);
  }
  return out;
}

function walk(value, visit, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, visit, [...trail, i]));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      visit({ key: k, trail });
      walk(v, visit, [...trail, k]);
    }
  } else {
    visit({ value, trail });
  }
}

const where = (trail) => trail.join('.') || '(top level)';

function envName(value, label) {
  if (typeof value !== 'string' || !ENV_NAME_RE.test(value)) {
    throw new UsageError(`${label} must be an environment variable NAME (letters, digits, _), got ${JSON.stringify(value)}`);
  }
  return value;
}

function intInRange(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${label} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new UsageError(`${label} must be true or false`);
  return value;
}

function requireEnvSet(env, name, label) {
  if (!String(env[name] ?? '').trim()) {
    throw new UsageError(`${label} names the environment variable ${name}, which is not set`, {
      hint: `export ${name} before starting Gate (never put the value in the config file)`,
    });
  }
}

function isPublicKey(text) {
  if (typeof text !== 'string' || text.length < 32 || text.length > 44) return false;
  try {
    return base58Decode(text).length === 32;
  } catch {
    return false;
  }
}

/**
 * Load, validate and deep-freeze a gate config (SPEC §5.1).
 * Also checks that every environment variable the config names is set, so a
 * missing variable is an exit 2 before anything is spawned.
 * @param {string} configPath
 * @param {Record<string, string|undefined>} env
 */
export function loadGateConfig(configPath, env = process.env) {
  if (!configPath) throw new UsageError('missing config path: sfcli gate run <config.json>');
  const absPath = path.resolve(configPath);
  const configDir = path.dirname(absPath);

  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read gate config ${absPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }
  if (!isPlainObject(raw)) throw new UsageError('gate config must be a JSON object');

  // GUARDRAIL — secrets never live in files. Every key, at every depth,
  // comments included: a commented-out key is still a secret on disk.
  walk(raw, ({ key, trail }) => {
    if (key !== undefined && SECRET_KEY_RE.test(key)) {
      throw new GuardrailError(
        `gate config defines "${key}" at ${where(trail)} — secret-bearing values must come from the environment, never a file. ` +
          'Values may NAME an environment variable (e.g. "walletVar": "PRIVATE_KEY").',
      );
    }
  });

  const file = stripComments(raw);

  // Example placeholders must never pass as real values.
  walk(file, ({ value, trail }) => {
    if (typeof value === 'string' && value.includes('REPLACE_')) {
      throw new UsageError(`gate config still has a placeholder at ${where(trail)}: ${JSON.stringify(value)}`);
    }
  });

  for (const key of Object.keys(file)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new UsageError(`unknown gate config key "${key}" (allowed: ${[...TOP_LEVEL_KEYS].join(', ')})`);
    }
  }

  if (!CLUSTERS.includes(file.cluster)) {
    throw new UsageError(`cluster must be one of ${CLUSTERS.join(' | ')}, got ${JSON.stringify(file.cluster)}`);
  }
  const cluster = file.cluster;

  const upstreamRpcEnv = envName(file.upstreamRpcEnv, 'upstreamRpcEnv');
  const upstreamWsEnv = file.upstreamWsEnv === undefined ? null : envName(file.upstreamWsEnv, 'upstreamWsEnv');

  let pettyCash = null;
  if (file.pettyCash !== undefined) {
    if (!isPlainObject(file.pettyCash)) throw new UsageError('pettyCash must be an object { "pathEnv": "<VAR>" }');
    for (const k of Object.keys(file.pettyCash)) {
      if (k !== 'pathEnv') throw new UsageError(`unknown key pettyCash.${k}`);
    }
    pettyCash = { pathEnv: envName(file.pettyCash.pathEnv, 'pettyCash.pathEnv') };
  }

  if (!isPublicKey(file.approver)) {
    throw new UsageError('approver must be a base58 Ed25519 public key (32 bytes) — the wallet that signs approvals');
  }

  // Every variable the config names: stripped from children, required set.
  const envNames = [upstreamRpcEnv, upstreamWsEnv, pettyCash?.pathEnv].filter(Boolean);

  // approval
  const approvalIn = file.approval === undefined ? {} : file.approval;
  if (!isPlainObject(approvalIn)) throw new UsageError('approval must be an object');
  for (const k of Object.keys(approvalIn)) {
    if (!APPROVAL_KEYS.has(k)) throw new UsageError(`unknown key approval.${k}`);
  }
  const approval = {
    method: approvalIn.method ?? 'wallet-signature',
    port: approvalIn.port === undefined ? GATE_DEFAULTS.approvalPort : intInRange(approvalIn.port, 'approval.port', 1, 65535),
    timeoutSec:
      approvalIn.timeoutSec === undefined
        ? GATE_DEFAULTS.approvalTimeoutSec
        : intInRange(approvalIn.timeoutSec, 'approval.timeoutSec', 1, GATE_DEFAULTS.approvalTimeoutSecMax),
    openBrowser: bool(approvalIn.openBrowser, 'approval.openBrowser', true),
    notify: bool(approvalIn.notify, 'approval.notify', true),
  };
  if (!APPROVAL_METHODS.includes(approval.method)) {
    throw new UsageError(`approval.method must be one of ${APPROVAL_METHODS.join(' | ')}`);
  }
  // I3: the button is a dev fallback; on mainnet only a wallet signature counts.
  if (approval.method === 'local-button' && !['devnet', 'localnet'].includes(cluster)) {
    throw new GuardrailError('approval.method "local-button" is allowed only on devnet or localnet');
  }
  const minTimeoutMs = (approval.timeoutSec + 30) * 1000;

  // servers
  if (!isPlainObject(file.servers) || Object.keys(file.servers).length === 0) {
    throw new UsageError('servers must be an object with at least one downstream MCP server');
  }
  const servers = {};
  for (const [name, entry] of Object.entries(file.servers)) {
    if (!SERVER_NAME_RE.test(name)) {
      throw new UsageError(`server name "${name}" must match ^[a-z0-9-]{1,16}$ (it becomes the tool-name prefix)`);
    }
    if (!isPlainObject(entry)) throw new UsageError(`servers.${name} must be an object`);
    for (const k of Object.keys(entry)) {
      if (!SERVER_KEYS.has(k)) throw new UsageError(`unknown key servers.${name}.${k} (allowed: ${[...SERVER_KEYS].join(', ')})`);
    }
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      throw new UsageError(`servers.${name}.command must be a non-empty string`);
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new UsageError(`servers.${name}.args must be an array of strings`);
    }
    if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !entry.cwd)) {
      throw new UsageError(`servers.${name}.cwd must be a path string`);
    }
    const cwd = path.resolve(configDir, entry.cwd ?? '.');

    const isGateName = (v) => /^SFGATE_/i.test(v) || envNames.some((n) => n.toUpperCase() === v.toUpperCase());
    const rpcVar = entry.rpcVar === undefined ? null : envName(entry.rpcVar, `servers.${name}.rpcVar`);
    const walletVar = entry.walletVar === undefined ? null : envName(entry.walletVar, `servers.${name}.walletVar`);
    for (const [label, v] of [['rpcVar', rpcVar], ['walletVar', walletVar]]) {
      if (v && isGateName(v)) throw new GuardrailError(`servers.${name}.${label} may not be a Gate variable (${v})`);
    }
    if (rpcVar && walletVar && rpcVar.toUpperCase() === walletVar.toUpperCase()) {
      throw new UsageError(`servers.${name}: rpcVar and walletVar must differ`);
    }
    const walletFormat = entry.walletFormat ?? 'base58-64';
    if (!WALLET_FORMATS.includes(walletFormat)) {
      throw new UsageError(`servers.${name}.walletFormat must be one of ${WALLET_FORMATS.join(' | ')}`);
    }
    if (walletVar && !pettyCash) {
      throw new UsageError(`servers.${name}.walletVar needs a top-level "pettyCash": { "pathEnv": "<VAR>" }`);
    }

    const envIn = entry.env ?? {};
    if (!isPlainObject(envIn)) throw new UsageError(`servers.${name}.env must be an object of literal strings`);
    const literalEnv = {};
    for (const [k, v] of Object.entries(envIn)) {
      envName(k, `servers.${name}.env key`);
      if (typeof v !== 'string') throw new UsageError(`servers.${name}.env.${k} must be a string`);
      if (isGateName(k)) throw new GuardrailError(`servers.${name}.env may not set a Gate variable (${k})`);
      if ([rpcVar, walletVar].some((x) => x && x.toUpperCase() === k.toUpperCase())) {
        throw new UsageError(`servers.${name}.env.${k} collides with rpcVar/walletVar, which Gate injects`);
      }
      literalEnv[k] = v;
    }

    const timeoutMs =
      entry.timeoutMs === undefined ? GATE_DEFAULTS.serverTimeoutMs : intInRange(entry.timeoutMs, `servers.${name}.timeoutMs`, 1, 3_600_000);
    // A call that times out for the agent while its transaction is still
    // approvable is the worst of both worlds: the agent retries, the human
    // approves the stale one.
    if (timeoutMs < minTimeoutMs) {
      throw new UsageError(
        `servers.${name}.timeoutMs (${timeoutMs}) must be >= (approval.timeoutSec + 30) x 1000 = ${minTimeoutMs}`,
      );
    }

    servers[name] = { command: entry.command, args: [...args], cwd, rpcVar, walletVar, walletFormat, env: literalEnv, timeoutMs };
  }

  // lists: name -> array of strings
  const lists = file.lists ?? {};
  if (!isPlainObject(lists)) throw new UsageError('lists must be an object of string arrays');
  for (const [k, v] of Object.entries(lists)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new UsageError(`lists.${k} must be an array of strings`);
  }

  // tools / tx: semantics belong to T2 / T4; here only the shape.
  const tools = file.tools ?? {};
  if (!isPlainObject(tools)) throw new UsageError('tools must be an object');
  for (const [k, v] of Object.entries(tools)) {
    if (typeof v !== 'string' && !isPlainObject(v)) throw new UsageError(`tools["${k}"] must be a mode string or an object`);
  }
  const tx = file.tx ?? {};
  if (!isPlainObject(tx)) throw new UsageError('tx must be an object');

  const rpcIn = file.rpcCheckpoint ?? {};
  if (!isPlainObject(rpcIn)) throw new UsageError('rpcCheckpoint must be an object');
  for (const k of Object.keys(rpcIn)) {
    if (k !== 'port') throw new UsageError(`unknown key rpcCheckpoint.${k}`);
  }
  // The WebSocket tunnel listens on port + 1.
  const rpcCheckpoint = {
    port: rpcIn.port === undefined ? GATE_DEFAULTS.checkpointPort : intInRange(rpcIn.port, 'rpcCheckpoint.port', 1, 65534),
  };

  const auditIn = file.audit ?? {};
  if (!isPlainObject(auditIn)) throw new UsageError('audit must be an object');
  for (const k of Object.keys(auditIn)) {
    if (k !== 'path') throw new UsageError(`unknown key audit.${k}`);
  }
  if (auditIn.path !== undefined && (typeof auditIn.path !== 'string' || !auditIn.path)) {
    throw new UsageError('audit.path must be a path string');
  }
  const audit = { path: path.resolve(configDir, auditIn.path ?? `sfgate-audit.${cluster}.jsonl`) };

  const showDeniedTools = bool(file.showDeniedTools, 'showDeniedTools', false);

  // Last, so that a config error is reported before an environment one.
  requireEnvSet(env, upstreamRpcEnv, 'upstreamRpcEnv');
  if (upstreamWsEnv) requireEnvSet(env, upstreamWsEnv, 'upstreamWsEnv');
  if (pettyCash) requireEnvSet(env, pettyCash.pathEnv, 'pettyCash.pathEnv');

  return deepFreeze({
    configPath: absPath,
    configDir,
    cluster,
    upstreamRpcEnv,
    upstreamWsEnv,
    pettyCash,
    approver: file.approver,
    servers,
    lists: structuredClone(lists),
    tools: structuredClone(tools),
    tx: structuredClone(tx),
    approval,
    rpcCheckpoint,
    audit,
    showDeniedTools,
    envNames,
  });
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkUrl(text, allowed, label) {
  let url;
  try {
    url = new URL(text);
  } catch {
    // Never echo the value: it may embed an API key.
    throw new UsageError(`${label} is not a valid URL`);
  }
  const [secure, plain] = allowed;
  if (url.protocol === `${secure}:`) return url;
  if (url.protocol === `${plain}:` && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new UsageError(`${label} must use ${secure}:// (${plain}:// is allowed only for 127.0.0.1 / localhost)`);
}

/**
 * Read the upstream RPC URL (and its WebSocket URL) from the environment at
 * the moment of use. Never stored on the config; errors never include it.
 * @returns {{ url: string, wsUrl: string }}
 */
export function resolveUpstream(config, env = process.env) {
  const raw = String(env[config.upstreamRpcEnv] ?? '').trim();
  if (!raw) throw new UsageError(`${config.upstreamRpcEnv} is not set`);
  const url = checkUrl(raw, ['https', 'http'], config.upstreamRpcEnv);
  let wsUrl;
  if (config.upstreamWsEnv) {
    const wsRaw = String(env[config.upstreamWsEnv] ?? '').trim();
    if (!wsRaw) throw new UsageError(`${config.upstreamWsEnv} is not set`);
    wsUrl = checkUrl(wsRaw, ['wss', 'ws'], config.upstreamWsEnv).href;
  } else {
    const derived = new URL(url.href);
    derived.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = derived.href;
  }
  return { url: raw, wsUrl };
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Load the petty-cash keypair (Solana CLI JSON array of 64 numbers).
 * The returned object hides its secret from JSON.stringify and the error
 * messages never name the file (its path is configuration, its content is not
 * ours to describe).
 * @returns {{ publicKey: string, secretKey: Uint8Array } | null}
 */
export function loadPettyCash(config, env = process.env) {
  if (!config.pettyCash) return null;
  const varName = config.pettyCash.pathEnv;
  const file = String(env[varName] ?? '').trim();
  if (!file) throw new UsageError(`${varName} is not set (pettyCash.pathEnv)`);
  const bad = (why) =>
    new UsageError(`petty-cash keypair file named by ${varName} ${why}`, {
      hint: 'expected a Solana CLI keypair file: a JSON array of 64 numbers (solana-keygen new -o <file>)',
    });

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    throw bad(err?.code === 'ENOENT' ? 'does not exist' : err instanceof SyntaxError ? 'is not valid JSON' : 'cannot be read');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw bad('is malformed (not an array of 64 bytes)');
  }
  const secretKey = Uint8Array.from(parsed);
  let derived;
  try {
    const priv = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(secretKey.subarray(0, 32))]),
      format: 'der',
      type: 'pkcs8',
    });
    derived = Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url');
  } catch {
    throw bad('is malformed (invalid Ed25519 seed)');
  }
  if (!derived.equals(Buffer.from(secretKey.subarray(32)))) {
    throw bad('is malformed (public half does not match the seed)');
  }
  const keypair = { publicKey: base58Encode(secretKey.subarray(32)), secretKey };
  Object.defineProperty(keypair, 'toJSON', {
    value: () => ({ publicKey: keypair.publicKey }),
    enumerable: false,
  });
  Object.defineProperty(keypair, 'secretKey', { value: secretKey, enumerable: false });
  return Object.freeze(keypair);
}

/**
 * The petty-cash secret in the format a downstream expects in its walletVar.
 * @param {{ secretKey: Uint8Array }} pettyCash
 * @param {'base58-64'|'json-array'} format
 */
export function walletValue(pettyCash, format) {
  if (format === 'json-array') return JSON.stringify([...pettyCash.secretKey]);
  return base58Encode(pettyCash.secretKey);
}

/** Every textual form a byte secret could leak in. */
function byteForms(bytes) {
  const arr = [...bytes];
  const forms = [
    base58Encode(bytes),
    JSON.stringify(arr),
    arr.join(', '),
    `[${arr.join(', ')}]`,
    arr.join(','),
    Buffer.from(bytes).toString('hex'),
    Buffer.from(bytes).toString('base64'),
  ];
  // A Solana keypair's first half is the seed: as dangerous on its own.
  if (bytes.length === 64) forms.push(...byteForms(bytes.subarray(0, 32)));
  return forms;
}

/**
 * Build Gate's own redactor (SPEC I4). `redactSensitive()` only knows
 * process.env; this knows the values Gate holds in memory.
 * Strings: replaced verbatim, plus their URL-normalised form and any query
 * value of 8+ characters (an API key in `?api-key=`). Byte arrays (the
 * petty-cash secret): base58, JSON-array (compact and spaced), hex, base64.
 * Longest first, so a secret's prefix never survives as a partial match.
 * @param {(string|Uint8Array|null|undefined)[]} secrets
 * @returns {(text: string) => string}
 */
export function createRedactor(secrets = []) {
  const needles = new Set();
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret instanceof Uint8Array) {
      for (const f of byteForms(secret)) needles.add(f);
      continue;
    }
    const s = String(secret);
    needles.add(s);
    try {
      const url = new URL(s);
      needles.add(url.href);
      for (const [, v] of url.searchParams) if (v.length >= 8) needles.add(v);
      if (url.password && url.password.length >= 8) needles.add(url.password);
      // A path segment that looks like an API key (e.g. /v2/<key>).
      for (const seg of url.pathname.split('/')) if (seg.length >= 16) needles.add(seg);
    } catch {
      /* not a URL: the literal is enough */
    }
  }
  const list = [...needles].filter((n) => n.length >= 8).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const n of list) if (out.includes(n)) out = out.split(n).join('<redacted>');
    return out;
  };
}
