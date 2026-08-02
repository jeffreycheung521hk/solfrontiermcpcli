// MCP over stdio: the transport.
//
// Everything wire-level lives here. Callers get promises and JSON; they never
// see a pipe. Design notes for the parts that are easy to get subtly wrong:
//
//  * StringDecoder, not chunk.toString(). A multi-byte UTF-8 character can be
//    split across two chunk boundaries; toString() would turn it into U+FFFD
//    and silently corrupt the frame. StringDecoder holds the partial bytes.
//  * A malformed line is a protocol error, not something to skip. Skipping
//    turns "the server is broken" into "the client timed out" — a lie that
//    costs real debugging time.
//  * Child death fails every in-flight request immediately. Waiting for a
//    timeout when we already know the answer is pure latency.
//  * stderr is captured into a bounded ring buffer and surfaced on failure.
//    Draining it is mandatory (a full pipe blocks the child); throwing it
//    away makes startup failures invisible.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import { TransportError, TimeoutError } from '../cli/exit-codes.mjs';
import { DEFAULTS } from '../config.mjs';
import { LineFramer } from './framing.mjs';

const STDERR_RING_LINES = 40;

export class McpSession {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #framer = new LineFramer();
  #stderrRing = [];
  #closed = false;
  #exitInfo = null;
  #verbose;
  #timeoutMs;
  #onFrame;

  constructor({ serverBin, serverArgs = [], dbPath, timeoutMs = DEFAULTS.timeoutMs, verbose = false, onFrame } = {}) {
    this.serverBin = serverBin;
    this.serverArgs = serverArgs;
    this.dbPath = dbPath;
    this.#timeoutMs = timeoutMs;
    this.#verbose = verbose;
    this.#onFrame = onFrame;
  }

  /** Recent server stderr — the diagnostic that is otherwise thrown away. */
  get stderrTail() {
    return this.#stderrRing.join('\n');
  }

  start() {
    const args = [...this.serverArgs, '--db', this.dbPath];
    // Array args, never shell:true — paths with spaces need no quoting and
    // nothing can be reinterpreted by a shell.
    this.#child = spawn(this.serverBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    this.#child.on('error', (err) => {
      this.#failAll(new TransportError(`cannot start server: ${err.message}`, { bin: this.serverBin }));
    });

    this.#child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal };
      this.#failAll(
        new TransportError(`server exited (code ${code}${signal ? `, signal ${signal}` : ''}) with requests in flight`, {
          stderrTail: this.stderrTail,
        }),
      );
    });

    const errDecoder = new StringDecoder('utf8');
    let errBuffer = '';
    this.#child.stderr.on('data', (chunk) => {
      errBuffer += errDecoder.write(chunk);
      let nl;
      while ((nl = errBuffer.indexOf('\n')) >= 0) {
        const line = errBuffer.slice(0, nl).replace(/\r$/, '');
        errBuffer = errBuffer.slice(nl + 1);
        this.#stderrRing.push(line);
        if (this.#stderrRing.length > STDERR_RING_LINES) this.#stderrRing.shift();
        if (this.#verbose) process.stderr.write(`${'[2m'}server|${'[0m'} ${line}\n`);
      }
    });

    this.#child.stdout.on('data', (chunk) => this.#ingest(chunk));
    return this;
  }

  #ingest(chunk) {
    for (const line of this.#framer.push(chunk)) {
      if (this.#verbose) process.stderr.write(`[2m<<[0m ${line}\n`);
      this.#onFrame?.('recv', line);

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Not skipped: a server that emits non-JSON on the JSON-RPC channel
        // is broken, and every waiting caller deserves to know now.
        this.#failAll(
          new TransportError('server sent a malformed line on the JSON-RPC channel', {
            line: line.slice(0, 200),
          }),
        );
        return;
      }
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const entry = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
      // Responses with unknown ids and server-initiated notifications are
      // ignored deliberately: this client makes no server-callable promises.
    }
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  #write(payload) {
    const line = JSON.stringify(payload);
    if (this.#verbose) process.stderr.write(`[2m>>[0m ${line}\n`);
    this.#onFrame?.('send', line);
    if (!this.#child?.stdin.writable) {
      throw new TransportError('server stdin is closed', { stderrTail: this.stderrTail });
    }
    this.#child.stdin.write(line + '\n');
  }

  /** Send a request and await its correlated response. */
  request(method, params, { timeoutMs = this.#timeoutMs, signal } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new TransportError('cancelled before send'));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new TimeoutError(`${method} timed out after ${timeoutMs}ms`, {
            hint: 'raise --timeout-ms, or run `doctor` to check the server is healthy',
            stderrTail: this.stderrTail,
          }),
        );
      }, timeoutMs);
      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new TransportError(`${method} cancelled`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (msg) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(msg);
        },
        reject,
        timer,
      });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Fire-and-forget: no id, no reply will ever come. */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async initialize(clientInfo = { name: 'solfrontier-cli', version: '1.0.0' }) {
    const response = await this.request('initialize', {
      protocolVersion: DEFAULTS.protocolVersion,
      capabilities: {},
      clientInfo,
    });
    if (response.error) {
      throw new TransportError(`initialize rejected: ${response.error.message ?? JSON.stringify(response.error)}`, {
        stderrTail: this.stderrTail,
      });
    }
    this.notify('notifications/initialized', {});
    this.serverInfo = response.result?.serverInfo ?? null;
    this.capabilities = response.result?.capabilities ?? {};
    return response.result;
  }

  async listTools() {
    const response = await this.request('tools/list', {});
    if (response.error) {
      throw new TransportError(`tools/list failed: ${response.error.message ?? JSON.stringify(response.error)}`);
    }
    return response.result?.tools ?? [];
  }

  /**
   * Call a tool and unwrap the layers.
   * Protocol errors throw (exit 3). Tool errors and domain statuses are
   * returned, because "the tool ran and said no" is a result, not a crash.
   */
  async callTool(name, args, options = {}) {
    const response = await this.request('tools/call', { name, arguments: args }, options);
    if (response.error) {
      throw new TransportError(
        `tool call rejected: ${response.error.message ?? JSON.stringify(response.error)}`,
        { tool: name, code: response.error.code },
      );
    }
    const text = (response.result?.content ?? []).map((c) => c.text ?? '').join('');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { isError: response.result?.isError === true, body };
  }

  /** EOF first (a well-behaved stdio server exits on it), terminate second. */
  async close({ graceMs = 750 } = {}) {
    if (this.#closed || !this.#child) return;
    this.#closed = true;
    if (this.#exitInfo) return;
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      this.#child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!this.#exitInfo) this.#child.kill(); // Windows: TerminateProcess
  }
}

/** Open a session, run a function, always clean up. */
export async function withSession(config, fn, { verbose = false, onFrame } = {}) {
  const session = new McpSession({ ...config, verbose, onFrame }).start();
  try {
    await session.initialize();
    return await fn(session);
  } finally {
    await session.close();
  }
}
