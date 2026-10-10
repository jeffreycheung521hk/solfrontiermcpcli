// The loopback approval page, as strings the approval server serves verbatim.
//
// No external resources at all: no fonts, no CDNs, no images. The CSP the
// server sends (script-src 'self') forbids inline script, so the page loads
// its logic from /app.js. Everything the page shows comes from a transaction
// someone else built -- memo text, program ids, tool names -- so it is only
// ever written with textContent, never parsed as HTML.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SolFrontier Gate approvals</title>
<link rel="icon" href="data:,">
<style>
  :root { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5f5f5a; --card: #ffffff; --line: #d9d9d4;
          --deny: #b3261e; --warn: #8a5a00; --ok: #1b6e3a; --accent: #3b3bb5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ececea; --muted: #a3a39e; --card: #20201f; --line: #3a3a37;
            --deny: #f2b8b5; --warn: #f0c46c; --ok: #8fd6a5; --accent: #b4b4ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header, main { max-width: 820px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 8px 0 4px; }
  .mode { color: var(--muted); margin: 0; overflow-wrap: anywhere; }
  .mode.insecure { color: var(--deny); font-weight: 600; }
  .status { margin: 8px 0 0; color: var(--muted); }
  .status.error { color: var(--deny); font-weight: 600; }
  .empty { color: var(--muted); }
  .hold { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
          padding: 16px; margin: 0 0 16px; }
  .hold.decided { opacity: 0.6; }
  .row { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
  .kind { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .countdown { font-variant-numeric: tabular-nums; font-weight: 600; }
  .countdown.low { color: var(--deny); }
  .summary { font-size: 18px; font-weight: 600; margin: 8px 0; overflow-wrap: anywhere; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 14px 0 4px; }
  ul { margin: 0; padding-left: 20px; }
  li { overflow-wrap: anywhere; }
  .violation { color: var(--deny); }
  .warning { color: var(--warn); }
  code, pre { font: 13px/1.4 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
        padding: 8px; margin: 4px 0 0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line);
           background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .result { margin-top: 10px; min-height: 1.2em; overflow-wrap: anywhere; }
  .result.error { color: var(--deny); font-weight: 600; }
  .result.ok { color: var(--ok); font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>SolFrontier Gate</h1>
  <p id="mode" class="mode">Loading...</p>
  <p id="status" class="status" role="status">Connecting to Gate...</p>
</header>
<main>
  <p id="empty" class="empty">No transactions are waiting for approval.</p>
  <div id="holds"></div>
</main>
<script src="/app.js" defer></script>
</body>
</html>
`;

export const APP_JS = `'use strict';
(() => {
  const POLL_MS = 1000;
  const TICK_MS = 250;
  const KEEP_DECIDED_MS = 15000;

  const holdsEl = document.getElementById('holds');
  const emptyEl = document.getElementById('empty');
  const statusEl = document.getElementById('status');
  const modeEl = document.getElementById('mode');

  const cards = new Map(); // id -> card state
  let config = { approver: null, method: 'wallet-signature', cluster: '' };
  let skewMs = 0; // server clock minus browser clock

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function section(parent, title) {
    parent.appendChild(el('h3', null, title));
  }

  async function api(path, body) {
    const init = body === undefined
      ? { cache: 'no-store', credentials: 'same-origin' }
      : {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
    const response = await fetch(path, init);
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function setResult(card, text, kind) {
    card.result.textContent = text;
    card.result.className = 'result' + (kind ? ' ' + kind : '');
  }

  function setBusy(card, busy) {
    card.busy = busy;
    for (const button of card.buttons) button.disabled = busy || card.decided || card.expired;
  }

  function amounts(parent, title, map) {
    const entries = Object.entries(map || {});
    if (entries.length === 0) return;
    section(parent, title);
    const list = el('ul');
    for (const [asset, amount] of entries) list.appendChild(el('li', null, amount + ' ' + asset));
    parent.appendChild(list);
  }

  function findings(parent, title, items, className) {
    if (!Array.isArray(items) || items.length === 0) return;
    section(parent, title);
    const list = el('ul');
    for (const item of items) {
      const text = (item && item.code ? item.code + ': ' : '') + (item && item.message ? item.message : JSON.stringify(item));
      list.appendChild(el('li', className, text));
    }
    parent.appendChild(list);
  }

  const IX_FIELDS = ['lamports', 'amount', 'decimals', 'mint', 'source', 'destination', 'authority', 'delegate', 'text'];

  function instructions(parent, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    section(parent, 'Instructions');
    const list = el('ul');
    for (const ix of items) {
      const item = el('li');
      item.appendChild(el('strong', null, '#' + ix.index + ' ' + (ix.program || 'unknown') + ' ' + (ix.kind || '')));
      item.appendChild(el('div', 'kind', ix.programId || ''));
      for (const field of IX_FIELDS) {
        if (ix[field] === undefined || ix[field] === null) continue;
        const line = el('div');
        line.appendChild(el('span', 'kind', field + ': '));
        line.appendChild(el('code', null, ix[field]));
        item.appendChild(line);
      }
      list.appendChild(item);
    }
    parent.appendChild(list);
  }

  async function approveWithWallet(hold) {
    const provider = window.phantom && window.phantom.solana;
    if (!provider || !provider.isPhantom) {
      throw new Error('Phantom was not found in this browser. Install or unlock Phantom, then reload this page.');
    }
    const connected = await provider.connect();
    const key = String((connected && connected.publicKey) || provider.publicKey || '');
    if (key !== config.approver) {
      throw new Error('The connected wallet ' + (key || '(none)') + ' is not the configured approver ' +
        config.approver + '. Switch to the approver account in Phantom and try again.');
    }
    const signed = await provider.signMessage(new TextEncoder().encode(hold.approvalMessage), 'utf8');
    const raw = signed && signed.signature;
    const signature = raw ? Uint8Array.from(raw) : null;
    if (!signature || signature.length !== 64) throw new Error('Phantom did not return a 64-byte signature.');
    const signer = signed.publicKey ? String(signed.publicKey) : key;
    if (signer !== config.approver) throw new Error('Phantom signed with ' + signer + ', not the approver.');
    return api('/api/holds/' + hold.id + '/approve', { publicKey: signer, signature: bytesToBase64(signature) });
  }

  function describeFailure(response) {
    const message = response.data && (response.data.message || response.data.error);
    return 'Gate refused (' + response.status + ')' + (message ? ': ' + message : '');
  }

  async function act(card, label, action) {
    if (card.busy) return;
    setBusy(card, true);
    setResult(card, label + '...', null);
    try {
      const response = await action();
      if (response.ok) {
        setResult(card, response.data && response.data.hold ? 'Done: ' + response.data.hold.status : 'Done.', 'ok');
        markDecided(card, response.data && response.data.hold ? response.data.hold.status : 'decided');
      } else {
        setResult(card, describeFailure(response), 'error');
        if (response.status === 409 || response.status === 410 || response.status === 404) markDecided(card, 'no longer pending');
      }
    } catch (err) {
      setResult(card, (err && err.message) || String(err), 'error');
    } finally {
      setBusy(card, false);
    }
  }

  function buildCard(hold) {
    const root = el('article', 'hold');
    const top = el('div', 'row');
    top.appendChild(el('span', 'kind', (hold.kind || '') + (hold.tool ? ' / ' + hold.tool : '') + ' / hold ' + hold.id));
    const countdown = el('span', 'countdown', '');
    top.appendChild(countdown);
    root.appendChild(top);
    root.appendChild(el('div', 'summary', hold.summaryLine || '(no summary)'));

    amounts(root, 'Leaves your wallet', hold.outflow);
    amounts(root, 'Arrives in your wallet', hold.inflow);
    findings(root, 'Violations', hold.violations, 'violation');
    findings(root, 'Warnings', hold.warnings, 'warning');
    instructions(root, hold.instructions);

    section(root, 'Transaction message SHA-256');
    root.appendChild(el('code', null, hold.messageSha256 || ''));
    section(root, 'Exact text your wallet will sign');
    root.appendChild(el('pre', null, hold.approvalMessage || ''));

    const actions = el('div', 'actions');
    const card = {
      id: hold.id,
      root,
      countdown,
      result: el('div', 'result'),
      buttons: [],
      expiresAtMs: Date.parse(hold.expiresAt),
      busy: false,
      decided: false,
      expired: false,
      removeAt: 0,
    };

    const approve = el('button', 'primary', 'Approve with wallet');
    approve.type = 'button';
    approve.addEventListener('click', () => act(card, 'Waiting for Phantom', () => approveWithWallet(hold)));
    actions.appendChild(approve);
    card.buttons.push(approve);

    if (config.method === 'local-button') {
      const local = el('button', null, 'Approve (insecure local button)');
      local.type = 'button';
      local.addEventListener('click', () => act(card, 'Approving', () =>
        api('/api/holds/' + hold.id + '/approve', { method: 'local-button' })));
      actions.appendChild(local);
      card.buttons.push(local);
    }

    const reject = el('button', null, 'Reject');
    reject.type = 'button';
    reject.addEventListener('click', () => act(card, 'Rejecting', () =>
      api('/api/holds/' + hold.id + '/reject', { reason: 'rejected in the approval page' })));
    actions.appendChild(reject);
    card.buttons.push(reject);

    root.appendChild(actions);
    root.appendChild(card.result);
    return card;
  }

  function markDecided(card, status) {
    if (card.decided) return;
    card.decided = true;
    card.root.classList.add('hold', 'decided');
    card.countdown.textContent = status;
    card.removeAt = Date.now() + KEEP_DECIDED_MS;
    setBusy(card, card.busy);
  }

  async function finalStatus(card) {
    try {
      const response = await api('/api/holds/' + card.id);
      const status = response.data && response.data.hold ? response.data.hold.status : 'no longer pending';
      markDecided(card, status);
      if (!card.result.textContent) setResult(card, 'This hold is ' + status + '.', status === 'approved' ? 'ok' : 'error');
    } catch (_) {
      markDecided(card, 'no longer pending');
    }
  }

  function tick() {
    const now = Date.now() + skewMs;
    for (const card of cards.values()) {
      if (card.decided) {
        if (card.removeAt && Date.now() >= card.removeAt) {
          card.root.remove();
          cards.delete(card.id);
        }
        continue;
      }
      const left = Math.max(0, Math.ceil((card.expiresAtMs - now) / 1000));
      card.countdown.textContent = left > 0 ? left + ' s left' : 'expired';
      card.countdown.className = 'countdown' + (left <= 10 ? ' low' : '');
      if (left === 0 && !card.expired) {
        card.expired = true;
        setBusy(card, card.busy);
      }
    }
    emptyEl.hidden = cards.size > 0;
  }

  function showMode() {
    const local = config.method === 'local-button';
    modeEl.className = 'mode' + (local ? ' insecure' : '');
    modeEl.textContent = 'Cluster: ' + config.cluster + ' | Approver: ' + config.approver +
      (local ? ' | INSECURE local-button mode (devnet/localnet only)' : '');
  }

  async function poll() {
    try {
      const sentAt = Date.now();
      const response = await api('/api/holds');
      if (!response.ok || !response.data || !Array.isArray(response.data.holds)) throw new Error('bad response');
      const receivedAt = Date.now();
      const serverNow = Date.parse(response.data.now);
      if (Number.isFinite(serverNow)) skewMs = serverNow - Math.round((sentAt + receivedAt) / 2);
      config = { approver: response.data.approver, method: response.data.method, cluster: response.data.cluster };
      showMode();
      statusEl.className = 'status';
      statusEl.textContent = 'Connected. Checking every second.';

      const pendingIds = new Set();
      for (const hold of response.data.holds) {
        pendingIds.add(hold.id);
        if (!cards.has(hold.id)) {
          const card = buildCard(hold);
          cards.set(hold.id, card);
          holdsEl.appendChild(card.root);
        }
      }
      for (const card of cards.values()) {
        if (!card.decided && !pendingIds.has(card.id) && !card.busy) finalStatus(card);
      }
    } catch (_) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Gate is not reachable. Nothing can be approved until it is.';
    } finally {
      tick();
      setTimeout(poll, POLL_MS);
    }
  }

  setInterval(tick, TICK_MS);
  poll();
})();
`;
