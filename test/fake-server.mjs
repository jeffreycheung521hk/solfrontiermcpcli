// A configurable fake MCP server, used by every hermetic test.
//
//   --hang            accept input, never reply
//   --garbage         emit a non-JSON line on the JSON-RPC channel
//   --die-mid         answer initialize, then die on the next request
//                     (deterministic: the client always has one in flight)
//   --slow <ms>       delay every reply
//   --wrong-id        reply with an id nobody is waiting for
//   --tool-error      tools/call returns isError: true
//   --rpc-error       tools/call returns a JSON-RPC error object
//   --split-utf8      emit a reply split mid-multibyte-character
//   --noisy-stderr    write server-style logs to stderr
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const slowMs = Number(valueOf('--slow', 0));

const TOOLS = [
  {
    name: 'echo_tool',
    description: 'Echoes its arguments back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' } },
      required: ['text'],
    },
  },
  {
    name: 'strict_tool',
    description: 'Requires two fields',
    inputSchema: {
      type: 'object',
      properties: { alpha: { type: 'string' }, beta: { type: 'number' } },
      required: ['alpha', 'beta'],
    },
  },
];

if (has('--noisy-stderr')) {
  process.stderr.write('INFO fake server starting\nINFO database opened\n');
}
if (has('--garbage')) process.stdout.write('NOT JSON AT ALL\n');

function write(text) {
  if (has('--split-utf8')) {
    // Split the payload mid-character to prove the client's decoder holds
    // partial bytes instead of producing replacement characters.
    const buf = Buffer.from(text, 'utf8');
    const cut = Math.floor(buf.length / 2);
    process.stdout.write(buf.subarray(0, cut));
    setTimeout(() => process.stdout.write(buf.subarray(cut)), 5);
  } else {
    process.stdout.write(text);
  }
}

function reply(payload) {
  const send = () => write(JSON.stringify(payload) + '\n');
  if (slowMs > 0) setTimeout(send, slowMs);
  else send();
}

const decoder = new StringDecoder('utf8');
let buffer = '';
let initialized = false;

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line || has('--hang')) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification: nothing to answer

    // Die with a request in flight, deterministically.
    if (has('--die-mid') && initialized) process.exit(1);

    if (has('--wrong-id')) {
      reply({ jsonrpc: '2.0', id: msg.id + 9999, result: {} });
      continue;
    }

    switch (msg.method) {
      case 'initialize':
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-server', version: '0.0.1' },
          },
        });
        initialized = true;
        break;

      case 'tools/list':
        reply({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
        break;

      case 'tools/call': {
        if (has('--rpc-error')) {
          reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'invalid params (simulated)' } });
          break;
        }
        const body = { tool: msg.params?.name, echoed: msg.params?.arguments ?? {}, note: 'café ☕ unicode' };
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: has('--tool-error') },
        });
        break;
      }

      default:
        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
