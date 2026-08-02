// `call <tool> --set k=v ...` — the generic, schema-driven escape hatch.
//
// This is what makes the CLI a real MCP client rather than a remote control
// for one server: it reads the tool's own inputSchema, coerces each --set
// value to the declared type, checks required fields, and refuses unknown
// keys before anything is sent. Point it at any MCP server.
import { withSession } from '../mcp/session.mjs';
import { emitResult, info, style } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'call',
  summary: 'Call any tool on any MCP server, with arguments checked against its schema',
  usage: 'call <tool-name> [--set key=value ...] [--args-json <json>] [--args-file <path>]',
  options: {
    set: { type: 'string', multiple: true },
    'args-json': { type: 'string' },
    'args-file': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
};

/** Coerce a string from the command line to the JSON type the schema wants. */
export function coerce(raw, schemaType) {
  switch (schemaType) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw)) throw new UsageError(`expected an integer, got ${JSON.stringify(raw)}`);
      return Number(raw);
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UsageError(`expected a number, got ${JSON.stringify(raw)}`);
      return n;
    }
    case 'boolean': {
      if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true;
      if (['false', '0', 'no'].includes(raw.toLowerCase())) return false;
      throw new UsageError(`expected a boolean, got ${JSON.stringify(raw)}`);
    }
    case 'array':
    case 'object': {
      try {
        return JSON.parse(raw);
      } catch {
        throw new UsageError(`expected JSON for a ${schemaType} field, got ${JSON.stringify(raw)}`);
      }
    }
    default:
      return raw; // string, or an unconstrained field
  }
}

/** Build and validate the arguments object from --set pairs plus the schema. */
export function buildArguments(schema, pairs, preset = {}) {
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const args = { ...preset };

  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--set expects key=value, got ${JSON.stringify(pair)}`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (Object.keys(properties).length && !(key in properties)) {
      throw new UsageError(
        `unknown argument "${key}". This tool accepts: ${Object.keys(properties).join(', ') || '(no declared properties)'}`,
      );
    }
    args[key] = coerce(raw, properties[key]?.type);
  }

  const missing = required.filter((key) => !(key in args));
  if (missing.length) throw new UsageError(`missing required argument(s): ${missing.join(', ')}`);
  return args;
}

export async function run({ config, flags, positionals, verbose }) {
  const toolName = positionals[1];
  if (!toolName) throw new UsageError('call needs a tool name (see `tools list`)');

  // Bulk arguments, for the cases where key=value is awkward. Both avoid
  // putting raw JSON on argv, which PowerShell 5.1 mangles.
  let preset = {};
  if (flags['args-file']) {
    const { readFileSync } = await import('node:fs');
    preset = JSON.parse(readFileSync(flags['args-file'], 'utf8'));
  } else if (flags['args-json']) {
    try {
      preset = JSON.parse(flags['args-json']);
    } catch (err) {
      throw new UsageError(`--args-json is not valid JSON: ${err.message}`);
    }
  }

  return withSession(config, async (session) => {
    const tools = await session.listTools();
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new UsageError(`no such tool "${toolName}". Available: ${tools.map((t) => t.name).join(', ')}`);
    }

    const args = buildArguments(tool.inputSchema, flags.set ?? [], preset);

    if (flags['dry-run']) {
      info(style.dim('dry run — nothing was sent'));
      emitResult({ tool: toolName, arguments: args });
      return EXIT.OK;
    }

    const { isError, body } = await session.callTool(toolName, args);
    emitResult(body);
    const domainError = body?.status !== undefined && body.status !== 'ok';
    return isError || domainError ? EXIT.FAILED : EXIT.OK;
  }, { verbose });
}
