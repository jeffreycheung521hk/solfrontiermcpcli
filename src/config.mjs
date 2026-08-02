// Configuration and guardrails.
//
// Precedence, highest wins:  flags > environment > config file > defaults
//
// The guardrails live here, in code, because a rule that exists only in a
// README is a rule that will eventually be skipped. They are honest about
// what they are: defence against operator mistakes, not a security boundary.
// A determined caller can rename a file or symlink around them. They exist
// to make the *accidental* wrong thing hard, and they say so.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GuardrailError, UsageError } from './cli/exit-codes.mjs';

export const DEFAULTS = {
  dbPath: 'scratch/dev.db',
  timeoutMs: 20000,
  protocolVersion: '2024-11-05',
};

/** Paths whose *contents* are audit artifacts and must never be opened. */
const PROTECTED_PATH_PATTERNS = [
  /solfrontiermcpskeleton[\\/]+data[\\/]+acceptance/i,
  /[\\/]acceptance[\\/].*\.db$/i,
];

function isProtected(target) {
  const candidates = [path.resolve(target)];
  // Resolve symlinks/junctions too, so the check isn't defeated by a link.
  try {
    if (existsSync(target)) candidates.push(realpathSync(target));
  } catch {
    /* unreadable path: the literal check below still applies */
  }
  return candidates.some((c) => PROTECTED_PATH_PATTERNS.some((re) => re.test(c)));
}

function parsePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${label} must be a positive integer, got ${JSON.stringify(String(value))}`);
  }
  return n;
}

/**
 * @param {object} flags parsed command-line flags
 * @param {object} env   process.env (injectable for tests)
 */
export function loadConfig(flags = {}, env = process.env) {
  const configPath = flags.config ?? env.SFCLI_CONFIG ?? path.resolve('sfcli.config.json');

  let file = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new UsageError(`cannot parse config file ${configPath}: ${err.message}`);
    }
  }

  // GUARDRAIL 1 — secrets never live in files.
  // Config files get committed; argv leaks into process listings. The RPC
  // endpoint may embed an API key, so it travels by environment only.
  for (const key of Object.keys(file)) {
    if (/rpc.?url|api.?key|secret|keypair|mnemonic|private/i.test(key)) {
      throw new GuardrailError(
        `config file defines "${key}" — secret-bearing values must come from the environment, never a file`,
      );
    }
  }

  const serverBin = flags.bin ?? env.SFCLI_BIN ?? file.serverBin;
  const dbPath = path.resolve(flags.db ?? env.SFCLI_DB ?? file.dbPath ?? DEFAULTS.dbPath);
  const timeoutMs = parsePositiveInt(
    flags['timeout-ms'] ?? env.SFCLI_TIMEOUT_MS ?? file.timeoutMs ?? DEFAULTS.timeoutMs,
    '--timeout-ms',
  );
  const serverArgs = Array.isArray(file.serverArgs) ? file.serverArgs : [];

  if (!serverBin) {
    throw new UsageError(
      'no server binary configured. Set it with --bin <path>, SFCLI_BIN, or "serverBin" in sfcli.config.json',
    );
  }

  // GUARDRAIL 2 — acceptance databases are audit evidence, not scratch space.
  if (isProtected(dbPath)) {
    throw new GuardrailError(
      `refusing to open ${dbPath}: acceptance databases are audit artifacts. Point --db at a scratch database instead.`,
    );
  }

  // GUARDRAIL 3 — this client speaks MCP. It never launches the executor
  // that moves money, no matter what the config file says.
  for (const arg of serverArgs) {
    if (String(arg).trim() === 'watch') {
      throw new GuardrailError('refusing to spawn the "watch" executor: this client is not an execution path');
    }
  }

  return {
    serverBin,
    serverArgs,
    dbPath,
    timeoutMs,
    configPath: existsSync(configPath) ? configPath : null,
    // Read-only view of what the environment supplies. The URL itself is
    // never returned, logged, or printed — only whether it is present.
    rpcUrlPresent: Boolean((env.SOLFRONTIER_RPC_URL ?? '').trim()),
    controlledKeypairEnvPresent: Boolean((env.SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR ?? '').trim()),
  };
}

/** The RPC endpoint, fetched only at the moment of use. Never stored. */
export function requireRpcUrl(env = process.env) {
  const url = (env.SOLFRONTIER_RPC_URL ?? '').trim();
  if (!url) {
    throw new UsageError(
      'SOLFRONTIER_RPC_URL is not set. This command reads the chain directly; set the environment variable (never a file or flag).',
    );
  }
  return url;
}

/** Redact anything that looks like the configured endpoint from a message. */
export function redact(text, env = process.env) {
  const url = (env.SOLFRONTIER_RPC_URL ?? '').trim();
  let out = String(text);
  if (url) out = out.split(url).join('<rpc-redacted>');
  return out.replace(/https?:\/\/[^\s"']+/g, '<url-redacted>');
}
