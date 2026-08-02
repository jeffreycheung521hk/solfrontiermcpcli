// solfrontier-cli — entry point and dispatcher.
//
// Ordering rule, deliberately enforced here: parse → validate → load config
// → ONLY THEN spawn anything. A missing flag must cost you an exit 2 and
// nothing else: no process started, no database touched, no migration run.
// Getting this backwards makes a usage mistake look like a transport failure,
// which is how you end up debugging the wrong thing.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { loadConfig, redact } from './config.mjs';
import { EXIT, CliError, UsageError } from './cli/exit-codes.mjs';
import { configureOutput, fail, info, warn, style, table } from './cli/output.mjs';

import * as toolsCmd from './commands/tools.mjs';
import * as callCmd from './commands/call.mjs';
import * as doctorCmd from './commands/doctor.mjs';
import * as auditCmd from './commands/audit.mjs';
import * as flowCmd from './commands/flow.mjs';
import { quote, position, status, propose, finalize, confirm } from './commands/intent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

// Commands that talk to a server need config; `audit` only needs the chain.
const REGISTRY = {
  tools: { ...toolsCmd, needsServer: true },
  call: { ...callCmd, needsServer: true },
  doctor: { ...doctorCmd, needsServer: true },
  flow: { ...flowCmd, needsServer: true },
  audit: { ...auditCmd, needsServer: false },
  quote: { spec: quote.spec, run: quote.run, validate: quote.validate, needsServer: true },
  position: { spec: position.spec, run: position.run, validate: position.validate, needsServer: true },
  status: { spec: status.spec, run: status.run, validate: status.validate, needsServer: true },
  propose: { spec: propose.spec, run: propose.run, validate: propose.validate, needsServer: true },
  finalize: { spec: finalize.spec, run: finalize.run, validate: finalize.validate, needsServer: true },
  confirm: { spec: confirm.spec, run: confirm.run, validate: confirm.validate, needsServer: true },
};

const GLOBAL_OPTIONS = {
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  color: { type: 'string' },
  bin: { type: 'string' },
  db: { type: 'string' },
  config: { type: 'string' },
  'timeout-ms': { type: 'string' },
};

function helpText(commandName) {
  const entry = REGISTRY[commandName];
  if (entry) {
    const lines = [
      `${style.bold(entry.spec.name)} — ${entry.spec.summary}`,
      '',
      `  sfcli ${entry.spec.usage}`,
    ];
    if (entry.spec.notes?.length) {
      lines.push('');
      for (const note of entry.spec.notes) lines.push(`  ${style.dim(note)}`);
    }
    return lines.join('\n');
  }
  const rows = Object.values(REGISTRY).map((c) => [c.spec.name, c.spec.summary]);
  return [
    `${style.bold('solfrontier-cli')} ${VERSION} — a bounded-intent MCP client`,
    '',
    'usage: sfcli <command> [flags]',
    '',
    ...rows.map(([n, s]) => `  ${n.padEnd(10)} ${s}`),
    '',
    'global flags:',
    '  --json            one JSON document on stdout (machine mode)',
    '  --quiet           suppress human commentary on stderr',
    '  --verbose, -v     dump every protocol frame and server log line',
    '  --bin <path>      server binary (or SFCLI_BIN, or config file)',
    '  --db <path>       state-store path (or SFCLI_DB, or config file)',
    '  --config <path>   config file (default ./sfcli.config.json)',
    '  --timeout-ms <n>  per-request deadline (default 20000)',
    '  --color auto|always|never',
    '  --help, -h        this help, or `sfcli <command> --help`',
    '  --version',
    '',
    `exit codes: 0 ok · 1 negative result · 2 usage/guardrail · 3 transport · 4 timeout`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  // Positionals are recovered before strict parsing so that `--help` on an
  // unknown command still produces the general help rather than a parse error.
  const bareWords = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      // A value-taking flag consumes the next token; don't mistake it for a command.
      const name = token.replace(/^--?/, '').split('=')[0];
      const known = GLOBAL_OPTIONS[name];
      const takesValue = known && known.type === 'string' && !token.includes('=');
      if (takesValue) i++;
      continue;
    }
    bareWords.push(token);
  }

  const commandName = bareWords[0];
  const entry = REGISTRY[commandName];

  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (!commandName || (!entry && !argv.some((a) => a === '--help' || a === '-h'))) {
    process.stderr.write(`${helpText(null)}\n`);
    return commandName ? EXIT.USAGE : EXIT.USAGE;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(`${helpText(commandName)}\n`);
    return EXIT.OK;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...(entry.spec.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    fail(err.message);
    process.stderr.write(`\n${helpText(commandName)}\n`);
    return EXIT.USAGE;
  }

  const flags = parsed.values;
  configureOutput({ json: flags.json, quiet: flags.quiet, color: flags.color ?? 'auto' });

  try {
    // 1. Validate arguments — before any process exists.
    const args = entry.validate ? entry.validate(flags) : undefined;

    // 2. Load config and run guardrails — still before any process exists.
    const config = entry.needsServer ? loadConfig(flags, env) : null;

    if (config?.controlledKeypairEnvPresent && commandName !== 'doctor') {
      warn(
        'SOLFRONTIER_CONTROLLED_WALLET_KEYPAIR is set in this environment. ' +
          'This CLI never spawns the executor, but a shell without it is safer.',
      );
    }

    // 3. Only now may a server be spawned.
    return await entry.run({
      config,
      flags,
      args,
      positionals: parsed.positionals,
      verbose: flags.verbose,
      env,
    });
  } catch (err) {
    if (err instanceof CliError) {
      fail(redact(err.message, env));
      if (err.details?.stderrTail) {
        info('');
        info(style.dim('last lines from the server:'));
        for (const line of String(err.details.stderrTail).split('\n').slice(-8)) {
          info(style.dim(`  ${line}`));
        }
      }
      if (err.details?.hint) info(style.dim(`hint: ${err.details.hint}`));
      if (err instanceof UsageError) process.stderr.write(`\n${helpText(commandName)}\n`);
      return err.exitCode;
    }
    fail(redact(err?.stack ?? String(err), env));
    return EXIT.FAILED;
  }
}

/**
 * Exit without truncating output or tripping over live handles.
 *
 * process.exit() is abrupt: on Windows it can abort inside libuv when stdio
 * writes to a pipe are still flushing or an HTTP socket is mid-close (an
 * `UV_HANDLE_CLOSING` assertion, which surfaces as a bogus exit code and
 * loses the tail of the output). So: set the code, help the loop drain, and
 * keep an unref'd backstop that only fires if something is still holding the
 * process open — it cannot itself delay a clean exit.
 */
async function shutdown(code) {
  process.exitCode = code;

  // Node's fetch keeps sockets alive in a global pool; close it if present.
  try {
    const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (dispatcher?.close) await dispatcher.close();
  } catch {
    /* best effort: never let cleanup change the outcome */
  }

  const backstop = setTimeout(() => process.exit(code), 2000);
  backstop.unref();
}

// Only run when executed directly, so tests can import main() cleanly.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.on('SIGINT', () => {
    process.exitCode = EXIT.INTERRUPTED;
    process.exit(EXIT.INTERRUPTED);
  });
  main().then(
    (code) => shutdown(code ?? EXIT.OK),
    (err) => {
      fail(String(err?.stack ?? err));
      return shutdown(EXIT.FAILED);
    },
  );
}

export { REGISTRY, helpText, VERSION };
