// A fake solfrontier MCP server with just enough funding lifecycle to drive
// the orchestration offline: propose -> finalize -> confirm, with the same
// state transitions and the same lateness rule as the real one.
//
// Deliberately faithful on the point that matters: confirm_funding decides
// lateness from the TRANSACTION's own time, never from when it was called.
// A payment that landed in time stays valid even if confirmed afterwards --
// that is what lets a late-listed payment still be recorded, and it is why
// the client must always attempt confirmation once a payment is proven.
//
//   --window-ms <n>       funding window (default 180000)
//   --confirm-fails <n>   first n confirm calls return a retryable status
//   --late                report the payment as having arrived after the deadline
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);

const WINDOW_MS = Number(valueOf('--window-ms', 180_000));
let confirmFailsLeft = Number(valueOf('--confirm-fails', 0));

const INTENT_ID = '58000000400d0300000000009a62dace';
const RULE_HASH = '711e70b5cb235df2b16c494ab8a21bb0c22bfce27a885b08ad41845c81368d10';
const CONTROLLED_ATA = '7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3';
const USER_ATA = '4bDArC4UVoBjecHUZaCKqhuhTYPoiKS4qpQQpxuvm1qn';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const state = { status: null, expiresAtMs: null, signature: null, confirmCalls: 0 };

const reply = (id, body, isError = false) =>
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError },
  }) + '\n');

function handleCall(id, name, args) {
  switch (name) {
    case 'propose_intent':
      return reply(id, {
        status: 'ok',
        draft_id: 'a'.repeat(32),
        draft_hash: 'b'.repeat(64),
        persistence: { db_row_exists: false },
        side_effects: { database_writes: 0, network_calls: 0, signatures: 0 },
      });

    case 'finalize_intent': {
      state.status = 'funding_required';
      state.expiresAtMs = Date.now() + WINDOW_MS;
      return reply(id, {
        status: 'funding_required',
        intent_id: INTENT_ID,
        rule_hash: RULE_HASH,
        funding_actionable: true,
        funding: {
          amount_raw: '200000',
          expires_at_ms: state.expiresAtMs,
          user_wallet: args.user_wallet,
          user_usdc_ata: USER_ATA,
          controlled_usdc_ata: CONTROLLED_ATA,
          mint: MINT,
          decimals: 6,
          memo: `claw:w5h:${INTENT_ID}:${RULE_HASH}`,
        },
        signing_page_url: 'http://127.0.0.1:8081/index.html#payload=fake',
      });
    }

    case 'confirm_funding': {
      state.confirmCalls++;
      if (confirmFailsLeft > 0) {
        confirmFailsLeft--;
        return reply(id, { status: 'pending_confirmation', intent_id: args.intent_id });
      }
      const late = has('--late');
      state.status = 'budget_reserved';
      state.signature = args.tx_signature;
      // Shaped after the real success_response in
      // bins/solfrontier-mcp/src/funding.rs. A fake that omits fields the
      // client is supposed to gate on cannot test the gate -- the same lesson
      // as commit 46ac86e, one layer up.
      const ruleExpiresSlot = 1480;
      const txSlot = has('--slot-expired') ? ruleExpiresSlot + 1
        : has('--no-tx-slot') ? null
          : 1000;
      const arrivalMs = late ? state.expiresAtMs + 1000 : state.expiresAtMs - 60_000;
      return reply(id, {
        status: 'budget_reserved',
        intent_id: args.intent_id,
        tx_signature: args.tx_signature,
        amount_raw: '200000',
        funding_finalized_slot: txSlot,
        confirmation_level: 'finalized',
        required_commitment: 'confirmed',
        funding_row_expires_at_ms: state.expiresAtMs,
        funding_deadline_basis: 'funding_row.expires_at_ms',
        funding_arrival_time_ms: arrivalMs,
        funding_arrival_time_source: 'funding_transaction.blockTime',
        // Lateness comes from the transaction, not from the call time.
        arrived_after_funding_deadline: late,
        watch_rule: {
          expires_at_slot: ruleExpiresSlot,
          funding_transaction_slot: txSlot,
          // Mirrors the server's `observed_slot.is_some_and(..)`: null slot
          // yields false, which is why the client must not read it alone.
          expired_at_funding_slot: txSlot !== null && txSlot >= ruleExpiresSlot,
          purpose: 'the 480-slot WatchRule deadline determines whether the executor can obtain a lease',
        },
        late_funding: late ? { note: 'arrived after the deadline; refundable' } : null,
        confirm_call_count: state.confirmCalls,
      });
    }

    case 'get_intent_status':
      return reply(id, {
        intent_ref: args.intent_ref,
        status: state.status ?? 'not_found',
        resolved_intent_id: INTENT_ID,
        is_terminal: false,
      });

    default:
      return reply(id, { status: 'unknown_tool', tool: name }, true);
  }
}

const decoder = new StringDecoder('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk);
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;

    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-solfrontier', version: '0.0.1' },
        },
      }) + '\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: ['propose_intent', 'finalize_intent', 'confirm_funding', 'get_intent_status',
            'get_quote', 'get_position'].map((name) => ({ name, inputSchema: { type: 'object' } })),
        },
      }) + '\n');
    } else if (msg.method === 'tools/call') {
      handleCall(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    }
  }
});
