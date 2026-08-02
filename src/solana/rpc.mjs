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

  getTransaction(signature, commitment = 'finalized') {
    return this.call('getTransaction', [signature, { maxSupportedTransactionVersion: 0, commitment }]);
  }

  getSignatureStatus(signature) {
    return this.call('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  }

  getSignaturesForAddress(address, limit = 25) {
    return this.call('getSignaturesForAddress', [address, { limit }]);
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
