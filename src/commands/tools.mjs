// `tools list` / `tools describe` — discover what a server offers.
import { withSession } from '../mcp/session.mjs';
import { emitResult, emitLines, info, isJsonMode, style } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';

export const spec = {
  name: 'tools',
  summary: 'List the tools a server exposes, or describe one in detail',
  usage: 'tools list | tools describe <tool-name>',
  options: {},
};

export async function run({ config, flags, positionals, verbose }) {
  const sub = positionals[1];
  if (sub !== 'list' && sub !== 'describe') {
    throw new UsageError('expected `tools list` or `tools describe <tool-name>`');
  }

  return withSession(config, async (session) => {
    const tools = await session.listTools();
    const server = session.serverInfo;

    if (sub === 'list') {
      info(`${style.bold(server?.name ?? 'server')} ${server?.version ?? ''} — ${tools.length} tools`);
      if (isJsonMode()) emitResult({ server, tools });
      else emitLines(tools.map((t) => t.name));
      return EXIT.OK;
    }

    const wanted = positionals[2];
    if (!wanted) throw new UsageError('tools describe needs a tool name');
    const tool = tools.find((t) => t.name === wanted);
    if (!tool) {
      info(`no such tool: ${wanted}`);
      info(`available: ${tools.map((t) => t.name).join(', ')}`);
      return EXIT.FAILED;
    }
    emitResult(tool);
    return EXIT.OK;
  }, { verbose });
}
