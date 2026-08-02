// Solend/Save reserve decoding and supply-APR math.
//
// This is an independent off-chain replica of the calculation the server
// performs on chain data. Having two implementations that must agree is the
// point: it is how `doctor` can tell you, before you commit to a 180-second
// window, whether the condition your intent depends on is actually true.
//
// Field offsets and the rate formula mirror the reserve layout used by the
// audited server (bins/solfrontier-mcp/src/finalize_market.rs).

export const MAINNET = {
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  SOLEND_PROGRAM: 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',
  MAIN_POOL_USDC_RESERVE: 'BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw',
  MAIN_POOL_LENDING_MARKET: '4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY',
  MAIN_POOL_USDC_COLLATERAL_MINT: '993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk',
  RESERVE_LIQUIDITY_SUPPLY: '8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf',
};

/** The executor refuses to act on reserve data older than this. */
export const MAX_RESERVE_STALENESS_SLOTS = 16;

const RESERVE_LEN = 619;
const OFF = {
  lastUpdateSlot: 1,
  stale: 9,
  availableAmount: 171,
  borrowedAmountWads: 179,
  optimalUtilizationRate: 299,
  minBorrowRate: 303,
  optimalBorrowRate: 304,
  maxBorrowRate: 305,
  protocolTakeRate: 372,
  maxUtilizationRate: 470,
  superMaxBorrowRate: 471,
};

const WAD = 10n ** 18n;
const BPS_WAD = 10n ** 14n;

const pctToWad = (p) => BigInt(p) * 10n ** 16n;
const mulWad = (a, b) => (a * b) / WAD;
const divWad = (a, b) => (a * WAD) / b;

function readU128LE(buf, offset) {
  let value = 0n;
  for (let i = 0; i < 16; i++) value += BigInt(buf[offset + i]) << BigInt(8 * i);
  return value;
}

export function decodeReserve(base64Data) {
  const data = Buffer.from(base64Data, 'base64');
  if (data.length !== RESERVE_LEN) {
    throw new Error(`unexpected reserve account length ${data.length} (expected ${RESERVE_LEN})`);
  }
  const staleByte = data[OFF.stale];
  if (staleByte !== 0 && staleByte !== 1) throw new Error('reserve stale flag is not a boolean');

  return {
    lastUpdateSlot: Number(data.readBigUInt64LE(OFF.lastUpdateSlot)),
    stale: staleByte === 1,
    availableAmount: data.readBigUInt64LE(OFF.availableAmount),
    borrowedAmountWads: readU128LE(data, OFF.borrowedAmountWads),
    optimalUtilizationRate: data[OFF.optimalUtilizationRate],
    minBorrowRate: data[OFF.minBorrowRate],
    optimalBorrowRate: data[OFF.optimalBorrowRate],
    maxBorrowRate: data[OFF.maxBorrowRate],
    protocolTakeRate: data[OFF.protocolTakeRate],
    maxUtilizationRate: data[OFF.maxUtilizationRate],
    superMaxBorrowRate: data.readBigUInt64LE(OFF.superMaxBorrowRate),
  };
}

export function utilizationWad(r) {
  if (r.borrowedAmountWads === 0n) return 0n;
  const denominator = r.borrowedAmountWads + BigInt(r.availableAmount) * WAD;
  if (denominator === 0n) return 0n;
  return divWad(r.borrowedAmountWads, denominator);
}

export function borrowRateWad(r) {
  const util = utilizationWad(r);
  const optimalUtil = pctToWad(r.optimalUtilizationRate);
  const maxUtil = pctToWad(r.maxUtilizationRate);

  if (util <= optimalUtil) {
    const minRate = pctToWad(r.minBorrowRate);
    if (optimalUtil === 0n) return minRate;
    return mulWad(divWad(util, optimalUtil), pctToWad(r.optimalBorrowRate - r.minBorrowRate)) + minRate;
  }
  if (util <= maxUtil) {
    const optimalRate = pctToWad(r.optimalBorrowRate);
    if (maxUtil - optimalUtil === 0n) return optimalRate;
    const weight = divWad(util - optimalUtil, maxUtil - optimalUtil);
    return mulWad(weight, pctToWad(r.maxBorrowRate) - optimalRate) + optimalRate;
  }
  const maxRate = pctToWad(r.maxBorrowRate);
  if (WAD - maxUtil === 0n) return pctToWad(r.superMaxBorrowRate);
  const weight = divWad(util - maxUtil, WAD - maxUtil);
  return mulWad(weight, pctToWad(r.superMaxBorrowRate) - maxRate) + maxRate;
}

/** Native supply APR in WAD, matching the server's condition formula v1. */
export function supplyAprWad(r) {
  const util = utilizationWad(r);
  const borrow = borrowRateWad(r);
  const afterTake = mulWad(util, WAD - pctToWad(r.protocolTakeRate));
  return mulWad(borrow, afterTake);
}

export const aprBpsFromWad = (wad) => Number(wad / BPS_WAD);

/** One complete, decision-ready snapshot of the reserve. */
export async function readReserveSnapshot(rpc, reserveAddress = MAINNET.MAIN_POOL_USDC_RESERVE) {
  const currentSlot = await rpc.getSlot('confirmed');
  const account = await rpc.getAccountInfo(reserveAddress);
  if (!account?.value) throw new Error(`reserve account ${reserveAddress} not found`);
  const reserve = decodeReserve(account.value.data[0]);
  const ageSlots = currentSlot - reserve.lastUpdateSlot;
  const aprWad = supplyAprWad(reserve);
  return {
    reserveAddress,
    currentSlot,
    lastUpdateSlot: reserve.lastUpdateSlot,
    ageSlots,
    staleFlag: reserve.stale,
    fresh: !reserve.stale && ageSlots >= 0 && ageSlots <= MAX_RESERVE_STALENESS_SLOTS,
    maxStalenessSlots: MAX_RESERVE_STALENESS_SLOTS,
    supplyAprBps: aprBpsFromWad(aprWad),
    supplyAprPct: Number((aprWad * 10000n) / WAD) / 100,
    utilizationPct: Number((utilizationWad(reserve) * 10000n) / WAD) / 100,
  };
}
