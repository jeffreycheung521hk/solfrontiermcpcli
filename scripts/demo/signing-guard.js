"use strict";

// Demo-only safety guard layered over the reviewed signing page. It does not
// build or send a transaction. It pins the URL payload, requires a live
// executor heartbeat, closes signing at T-60, and makes the first Phantom
// submission attempt a persistent one-shot boundary across refreshes/tabs.
(() => {
  const PIN = Object.freeze({
    intentId: "58000000400d0300000000009a62dace",
    amountRaw: "200000",
    userWallet: "C4QQjzWxnJ5QFAbkzhQJ3wTzyX6nw1vyFvJwbPXJGPNW",
    userAta: "4bDArC4UVoBjecHUZaCKqhuhTYPoiKS4qpQQpxuvm1qn",
    controlledWallet: "BPfDMmeMBmCbMC1rWh7hwigMBoKGBrKwXxSeUu9hhs5L",
    controlledAta: "7LFdKcSV7JQYi3or5y9phHVPjhGigu5DDjUakAFbBmk3",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    memoProgram: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  });

  let payload = null;
  let payloadSafe = false;
  let executorReady = false;
  let sentOrUnknown = false;
  let latchKey = null;

  const signButton = document.getElementById("sign-button");
  const retryButton = document.getElementById("retry-button");

  function readLatch() {
    try {
      return latchKey !== null && localStorage.getItem(latchKey) === "1";
    } catch (_) {
      return true;
    }
  }

  function writeLatch() {
    try {
      localStorage.setItem(latchKey, "1");
      return true;
    } catch (_) {
      return false;
    }
  }

  function parseAndPinPayload() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if ([...params.keys()].length !== 1 || params.getAll("payload").length !== 1) {
      throw new Error("fragment_shape");
    }
    const body = JSON.parse(params.get("payload"));
    const funding = body?.funding;
    const ruleHash = body?.rule_hash;
    const expectedMemo = `claw:w5h:${PIN.intentId}:${ruleHash}`;
    const exact =
      body?.status === "funding_required" &&
      body?.funding_actionable === true &&
      body?.intent_id === PIN.intentId &&
      typeof ruleHash === "string" &&
      /^[0-9a-f]{64}$/.test(ruleHash) &&
      funding?.amount_raw === PIN.amountRaw &&
      funding?.user_wallet === PIN.userWallet &&
      funding?.user_usdc_ata === PIN.userAta &&
      funding?.controlled_wallet === PIN.controlledWallet &&
      funding?.controlled_usdc_ata === PIN.controlledAta &&
      funding?.mint === PIN.mint &&
      funding?.memo_program_id === PIN.memoProgram &&
      funding?.decimals === 6 &&
      funding?.memo === expectedMemo &&
      Array.isArray(funding?.instruction_order) &&
      funding.instruction_order.length === 2 &&
      funding.instruction_order[0] === "memo" &&
      funding.instruction_order[1] === "transfer_checked" &&
      Number.isSafeInteger(funding?.expires_at_ms) &&
      funding.expires_at_ms > Date.now() + 60000;
    if (!exact) throw new Error("payload_pin_mismatch");
    payload = body;
    latchKey = `solfrontier-demo-sent:${funding.memo}`;
    sentOrUnknown = readLatch();
    payloadSafe = true;
  }

  function signingWindowOpen() {
    return payloadSafe && Date.now() < payload.funding.expires_at_ms - 60000;
  }

  function enforceButtons() {
    if (readLatch()) {
      sentOrUnknown = true;
    }
    const blocked = sentOrUnknown || !executorReady || !signingWindowOpen();
    if (signButton && blocked) signButton.disabled = true;
    if (retryButton) {
      retryButton.disabled = true;
      retryButton.hidden = true;
      retryButton.style.display = "none";
    }
    document.documentElement.dataset.demoGuard = blocked ? "blocked" : "ready";
  }

  async function refreshExecutorHeartbeat() {
    executorReady = false;
    try {
      const response = await fetch(`executor-heartbeat.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("heartbeat_http");
      const heartbeat = await response.json();
      const ageMs = Date.now() - Date.parse(heartbeat.updatedAtUtc);
      const ttlMs = Date.parse(heartbeat.expiresAtUtc) - Date.now();
      const requiredTtlMs = payload
        ? payload.funding.expires_at_ms + 60000 - Date.now()
        : 300000;
      executorReady =
        heartbeat.intentId === PIN.intentId &&
        heartbeat.amountRaw === PIN.amountRaw &&
        heartbeat.state === "idle-no-candidate" &&
        ageMs >= -5000 &&
        ageMs <= 10000 &&
        ttlMs >= requiredTtlMs;
    } catch (_) {
      executorReady = false;
    }
    enforceButtons();
  }

  function blockEvent(event, message) {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.alert(message);
  }

  window.addEventListener(
    "click",
    (event) => {
      const button = event.target?.closest?.("#sign-button, #retry-button");
      if (!button) return;
      if (button.id === "retry-button") {
        blockEvent(event, "Retry is disabled. Check the chain for the first outcome.");
        return;
      }
      if (sentOrUnknown) {
        blockEvent(event, "A Phantom submission was already attempted. Never send twice.");
        return;
      }
      if (!payloadSafe || !executorReady || !signingWindowOpen()) {
        blockEvent(event, "Signing is blocked: payload, executor heartbeat, or T-60 gate is not ready.");
        return;
      }

      // This latch is set before the original page calls Phantom. Any success,
      // exception, timeout, refresh or second tab remains outcome-unknown and
      // cannot create another transfer with a fresh blockhash.
      if (!writeLatch()) {
        blockEvent(event, "Persistent one-shot storage is unavailable; signing remains blocked.");
        return;
      }
      sentOrUnknown = true;
      setTimeout(enforceButtons, 0);
    },
    true,
  );

  window.addEventListener("storage", enforceButtons);

  try {
    parseAndPinPayload();
  } catch (_) {
    payloadSafe = false;
  }
  enforceButtons();
  refreshExecutorHeartbeat();
  setInterval(refreshExecutorHeartbeat, 1000);
  setInterval(enforceButtons, 250);
})();
