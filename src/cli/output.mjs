// The output contract, in one place.
//
//   stdout  = the RESULT, and nothing else.
//             In --json mode: exactly one JSON document, no trailing prose.
//   stderr  = everything else: progress, warnings, frames, errors, tables
//             meant for humans while a machine consumes stdout.
//
// That split is what makes `... --json | ConvertFrom-Json` safe in PowerShell
// and `... --json | jq` safe everywhere else.
import process from 'node:process';

let jsonMode = false;
let quiet = false;
let useColor = false;

export function configureOutput({ json = false, quiet: q = false, color = 'auto' } = {}) {
  jsonMode = json;
  quiet = q;
  useColor =
    color === 'always' ||
    (color === 'auto' && process.stderr.isTTY === true && !process.env.NO_COLOR);
}

export const isJsonMode = () => jsonMode;

const CODES = { dim: '2', red: '31', green: '32', yellow: '33', blue: '34', bold: '1' };
function paint(code, text) {
  return useColor ? `[${CODES[code]}m${text}[0m` : text;
}
export const style = {
  dim: (t) => paint('dim', t),
  red: (t) => paint('red', t),
  green: (t) => paint('green', t),
  yellow: (t) => paint('yellow', t),
  blue: (t) => paint('blue', t),
  bold: (t) => paint('bold', t),
};

/** The single result document. Call at most once per run. */
export function emitResult(value) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(value) + '\n');
  } else if (typeof value === 'string') {
    process.stdout.write(value.endsWith('\n') ? value : value + '\n');
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  }
}

/** Plain lines on stdout (list output in human mode). */
export function emitLines(lines) {
  process.stdout.write(lines.map((l) => `${l}\n`).join(''));
}

// --- human channel (stderr) ---------------------------------------------
export function info(message) {
  if (!quiet) process.stderr.write(`${message}\n`);
}
export function warn(message) {
  process.stderr.write(`${style.yellow('warning')} ${message}\n`);
}
export function fail(message) {
  process.stderr.write(`${style.red('error')} ${message}\n`);
}
export function step(message) {
  if (!quiet) process.stderr.write(`${style.dim('·')} ${message}\n`);
}

/** Structured machine-readable event on stderr (NDJSON) for audit trails. */
export function event(type, fields = {}) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), type, ...fields }) + '\n');
}

/** Fixed-width table on stderr. Rows are arrays of strings. */
export function table(headers, rows) {
  if (quiet) return;
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(String(r[i] ?? '')).length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i] + (String(c ?? '').length - stripAnsi(String(c ?? '')).length))).join('  ').trimEnd();
  process.stderr.write(`${style.bold(line(headers))}\n`);
  process.stderr.write(`${style.dim(widths.map((w) => '-'.repeat(w)).join('  '))}\n`);
  for (const row of rows) process.stderr.write(`${line(row)}\n`);
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

export const CHECK = () => style.green('PASS');
export const CROSS = () => style.red('FAIL');
