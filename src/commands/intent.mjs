// The solfrontier-specific convenience commands: quote, position, status,
// propose, finalize, confirm.
//
// Each is a thin, validated wrapper over one MCP tool. All parameter checking
// happens in `validate()`, which the dispatcher runs BEFORE any server
// process is spawned — so a missing flag is a usage error (exit 2), never a
// transport error from a server that should not have been started.
import { withSession } from '../mcp/session.mjs';
import { emitResult } from '../cli/output.mjs';
import { EXIT, UsageError } from '../cli/exit-codes.mjs';
import { MAINNET } from '../solana/solend.mjs';

const SYMBOLS = {
  SOL: { mint: MAINNET.SOL_MINT, decimals: 9 },
  USDC: { mint: MAINNET.USDC_MINT, decimals: 6 },
};

/** The pinned identities of the solfrontier rail (public on-chain values). */
export const RAIL = {
  action: 'deposit',
  protocol: 'solend',
  asset: 'USDC',
  display_source: 'save',
  comparison: 'gt',
  expiry_seconds_after_finalize: 180,
  controlled_wallet: 'BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L',
  controlled_usdc_ata: '7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3',
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;

/** Decimal string -> base units, in BigInt. Floats never touch money. */
export function toRawAmount(decimal, decimals) {
  if (typeof decimal !== 'string' || !/^\d+(\.\d+)?$/.test(decimal)) return null;
  const [whole, frac = ''] = decimal.split('.');
  if (frac.length > decimals) return null;
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

function requireFlag(flags, name, label = name) {
  const value = flags[name];
  if (value === undefined || value === '') throw new UsageError(`missing required flag --${label}`);
  return value;
}

function requireBase58(flags, name) {
  const value = requireFlag(flags, name);
  if (!BASE58.test(value)) throw new UsageError(`--${name} is not a base58 address: ${JSON.stringify(value)}`);
  return value;
}

function requireUsdcAmount(flags) {
  const amount = requireFlag(flags, 'amount');
  if (toRawAmount(amount, 6) === null) {
    throw new UsageError(`--amount ${JSON.stringify(amount)} is not a valid USDC decimal (max 6 dp)`);
  }
  return amount;
}

function requireThresholdBps(flags) {
  const raw = requireFlag(flags, 'threshold-bps');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    throw new UsageError(`--threshold-bps must be an integer 1..10000, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * The message text is hashed into the draft, so propose and finalize must use
 * exactly the same string. Deriving it from the parameters makes that
 * automatic; passing --message means you must pass the identical one twice.
 */
export function defaultMessage(amount, thresholdBps) {
  return `Deposit ${amount} USDC into Solend when Save APY is above ${(thresholdBps / 100).toFixed(2)}%`;
}

export function draftParams(flags) {
  const amount = requireUsdcAmount(flags);
  const thresholdBps = requireThresholdBps(flags);
  return {
    ...RAIL,
    amount,
    threshold_bps: thresholdBps,
    original_user_message: flags.message ?? defaultMessage(amount, thresholdBps),
  };
}

const domainExit = (isError, body, okWhen) =>
  isError || !okWhen(body ?? {}) ? EXIT.FAILED : EXIT.OK;

async function callAndEmit(config, verbose, tool, args, okWhen) {
  return withSession(config, async (session) => {
    const { isError, body } = await session.callTool(tool, args);
    emitResult(body);
    return domainExit(isError, body, okWhen);
  }, { verbose });
}

// --------------------------------------------------------------- commands

export const quote = {
  spec: {
    name: 'quote',
    summary: 'Jupiter price quote (read-only preview; builds no transaction)',
    usage: 'quote --amount 0.5 --input SOL --output USDC [--slippage-bps 50]',
    options: {
      amount: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      'slippage-bps': { type: 'string' },
    },
  },
  validate(flags) {
    const input = SYMBOLS[String(flags.input ?? '').toUpperCase()];
    const output = SYMBOLS[String(flags.output ?? '').toUpperCase()];
    if (!input || !output) {
      throw new UsageError('--input and --output must each be SOL or USDC');
    }
    const amount = requireFlag(flags, 'amount');
    const raw = toRawAmount(amount, input.decimals);
    if (raw === null) {
      throw new UsageError(`--amount ${JSON.stringify(amount)} is not valid for ${input.decimals} decimals`);
    }
    const slippage = Number(flags['slippage-bps'] ?? 50);
    if (!Number.isInteger(slippage) || slippage < 1 || slippage > 100) {
      throw new UsageError('--slippage-bps must be an integer 1..100 (the server policy-blocks anything higher)');
    }
    return { input_mint: input.mint, output_mint: output.mint, amount: raw, slippage_bps: slippage };
  },
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'get_quote', args, (b) => b.status === 'ok'),
};

export const position = {
  spec: {
    name: 'position',
    summary: 'Read a wallet’s Solend position (read-only)',
    usage: 'position --wallet <base58>',
    options: { wallet: { type: 'string' } },
  },
  validate: (flags) => ({ wallet: requireBase58(flags, 'wallet') }),
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'get_position', args, (b) => b.status === 'ok'),
};

export const status = {
  spec: {
    name: 'status',
    summary: 'Look up a bounded intent by id, UUID, or canonical rule hash',
    usage: 'status --ref <intent-id | uuid | rule-hash>',
    options: { ref: { type: 'string' } },
  },
  validate: (flags) => ({ intent_ref: requireFlag(flags, 'ref') }),
  // grep convention: a clean "not found" is exit 1, not an error.
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'get_intent_status', args,
      (b) => b.status !== undefined && b.status !== 'not_found' && b.status !== 'unsupported_ref'),
};

export const propose = {
  spec: {
    name: 'propose',
    summary: 'Compute a draft intent hash (pure: no DB row, no network, no signature)',
    usage: 'propose --amount 0.2 --threshold-bps 90 [--message "..."]',
    options: {
      amount: { type: 'string' },
      'threshold-bps': { type: 'string' },
      message: { type: 'string' },
    },
  },
  validate: (flags) => draftParams(flags),
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'propose_intent', args, (b) => b.status === 'ok'),
};

export const finalize = {
  spec: {
    name: 'finalize',
    summary: 'WRITES THE DATABASE: consume a draft and create the funding rows',
    usage:
      'finalize --amount 0.2 --threshold-bps 90 --draft-id <id> --draft-hash <hash> --user-wallet <base58> [--message "..."]',
    options: {
      amount: { type: 'string' },
      'threshold-bps': { type: 'string' },
      message: { type: 'string' },
      'draft-id': { type: 'string' },
      'draft-hash': { type: 'string' },
      'user-wallet': { type: 'string' },
    },
    notes: [
      'If you passed --message to `propose`, you MUST pass the identical text here:',
      'the message is hashed into the draft, so any difference fails the hash check.',
    ],
  },
  validate(flags) {
    const base = draftParams(flags);
    const draftHash = requireFlag(flags, 'draft-hash');
    if (!/^[0-9a-f]{64}$/.test(draftHash)) {
      throw new UsageError('--draft-hash must be 64 lowercase hex characters (copy it from `propose`)');
    }
    return {
      ...base,
      draft_id: requireFlag(flags, 'draft-id'),
      draft_hash: draftHash,
      user_wallet: requireBase58(flags, 'user-wallet'),
    };
  },
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'finalize_intent', args,
      (b) => b.status === 'funding_required' && b.funding_actionable === true),
};

export const confirm = {
  spec: {
    name: 'confirm',
    summary: 'WRITES THE DATABASE: verify a funding transaction on chain, then reserve the budget',
    usage: 'confirm --intent-id <hex> --tx-signature <base58>',
    options: { 'intent-id': { type: 'string' }, 'tx-signature': { type: 'string' } },
  },
  validate(flags) {
    const signature = requireFlag(flags, 'tx-signature');
    if (!SIGNATURE.test(signature)) {
      throw new UsageError('--tx-signature is not a base58 Solana signature');
    }
    return { intent_id: requireFlag(flags, 'intent-id'), tx_signature: signature };
  },
  run: ({ config, verbose, args }) =>
    callAndEmit(config, verbose, 'confirm_funding', args, (b) => b.status === 'budget_reserved'),
};
