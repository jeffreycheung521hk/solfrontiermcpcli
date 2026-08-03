// A small, dependency-free Solana JSON-RPC client.
//
// Only what this CLI genuinely needs. Every error is scrubbed of the endpoint
// before it leaves this module: the RPC URL may carry an API key, so it must
// never reach a log, a result, or a thrown message.
import { requireRpcUrl, redact } from '../config.mjs';
import { CliError, TransportError, EXIT } from '../cli/exit-codes.mjs';

export class RpcError extends CliError {
  constructor(message, details) {
    super(message, EXIT.TRANSPORT, details);
  }
}

export class SolanaRpc {
  #url;
  #timeoutMs;
  #id = 1;

  constructor({ timeoutMs = 15000, env } = {}) {
    this.#url = requireRpcUrl(env);
    this.#timeoutMs = timeoutMs;
  }

  async call(method, params = []) {
    let response;
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new RpcError(`RPC ${method} failed: ${redact(err.message)}`);
    }
    if (!response.ok) throw new RpcError(`RPC ${method} returned HTTP ${response.status}`);
    let json;
    try {
      json = await response.json();
    } catch {
      throw new RpcError(`RPC ${method} returned a non-JSON body`);
    }
    if (json.error) {
      throw new RpcError(`RPC ${method}: ${redact(json.error.message ?? JSON.stringify(json.error))}`);
    }
    return json.result;
  }

  getSlot(commitment = 'confirmed') {
    return this.call('getSlot', [{ commitment }]);
  }

  getAccountInfo(pubkey, commitment = 'confirmed') {
    return this.call('getAccountInfo', [pubkey, { encoding: 'base64', commitment }]);
  }

  // `encoding` is NOT optional here, however harmless the default looks.
  // Omitting it selects "json": compiled instructions ({programIdIndex,
  // accounts, data}) and accountKeys as bare strings. Every check in
  // funding-proof.mjs reads `programId`, `parsed` and `accountKeys[].signer`,
  // which exist only under jsonParsed, so the default makes a perfectly
  // correct payment fail at `payer_did_not_sign` -- and findFundingMatches
  // discards the reason, so the client goes silent over money already on
  // chain. That is the 2026-08-03 failure; the fixture never caught it
  // because it was captured with jsonParsed explicitly requested.
  getTransaction(signature, commitment = 'finalized') {
    return this.call('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment },
    ]);
  }

  getSignatureStatus(signature) {
    return this.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  }

  // The commitment is explicit and matches getTransaction's. Left implicit it
  // defaults to `finalized` while the fetch runs at `confirmed`, so the listing
  // and the fetch disagree about which chain state they are reading -- the
  // listing lagging the fetch by a full finality interval, on the one path
  // where seconds decide whether money is recorded.
  getSignaturesForAddress(address, limit = 25, commitment = 'confirmed') {
    return this.call('getSignaturesForAddress', [address, { limit, commitment }]);
  }

  async getTokenBalance(owner, mint) {
    const result = await this.call('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    return (result?.value ?? []).map((a) => ({
      ata: a.pubkey,
      amountRaw: a.account.data.parsed.info.tokenAmount.amount,
      uiAmount: a.account.data.parsed.info.tokenAmount.uiAmountString,
    }));
  }
}

export { TransportError };
