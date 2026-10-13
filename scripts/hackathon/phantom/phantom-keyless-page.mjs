// Local page only. The backend owns policy, simulation, approval and submission.
export const PAGE_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>SolFrontier · Phantom 手動簽署</title>
  <style>
    :root{font:17px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1b2636;background:#f4f6f9;color-scheme:light}
    *{box-sizing:border-box}body{margin:0}main{max-width:820px;margin:32px auto;padding:0 20px 40px}h1{font-size:1.65rem;margin:0 0 8px}h2{font-size:1.13rem;margin:0 0 12px}p{margin:8px 0 16px}.card{background:white;border:1px solid #dce3eb;border-radius:14px;padding:22px;margin:18px 0}.muted{color:#536176}.notice{border-left:5px solid #ce8800;background:#fff8e9;padding:14px 16px;border-radius:6px}.status{font-weight:600}.address,code{overflow-wrap:anywhere;word-break:break-all;font:0.86rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.address{display:block;margin:5px 0 14px;padding:9px 11px;background:#f3f6fa;border-radius:6px}button,.button-link{font:inherit;font-weight:650;border:0;border-radius:8px;padding:11px 17px;background:#174bb5;color:white;cursor:pointer;display:inline-block;text-decoration:none;margin:4px 8px 4px 0}button:disabled{opacity:.42;cursor:not-allowed}.secondary{background:#e9eef5;color:#29384c}.error{color:#92282b;background:#fff0f0;padding:12px 15px;border-radius:8px;overflow-wrap:anywhere}.success{color:#185d39;background:#ecf8f0;padding:12px 15px;border-radius:8px}a{color:#174bb5}dl{display:grid;grid-template-columns:135px 1fr;gap:9px 14px;margin:15px 0}dt{color:#536176}dd{margin:0;overflow-wrap:anywhere}ul,ol{padding-left:24px}li{margin:7px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:12px;border-radius:7px;font-size:.86rem}details{margin:12px 0}summary{cursor:pointer;color:#435573}[hidden]{display:none!important}@media(max-width:540px){main{margin-top:20px;padding:0 14px 24px}.card{padding:17px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}button{width:100%;margin-right:0}}
  </style>
  <script src="/solana-web3.js" defer></script>
  <script src="/app.js" defer></script>
</head>
<body>
<main>
  <h1>Phantom 手動簽署</h1>
  <p class="muted">Solana 主網 · 小額測試：<strong>0.001 SOL → USDC</strong></p>
  <div class="notice">此頁只透過 Phantom 請你簽署交易，不會索取私鑰或助記詞。付款簽署後，仍須由 Gate Approver 核准，才會交給 Jupiter 執行。</div>

  <section class="card" aria-labelledby="status-heading">
    <h2 id="status-heading">目前狀態</h2>
    <p id="status" class="status" role="status" aria-live="polite">正在連接本機服務…</p>
    <p id="clock" class="muted" hidden></p>
    <p id="pause-note" class="notice" hidden>測試目前暫停。請先完成 Phantom 帳號準備；收到恢復測試的確認後，才會啟用操作按鈕。</p>
    <p id="error" class="error" role="alert" hidden></p>
    <p id="result" aria-live="polite" hidden></p>
    <a id="explorer" target="_blank" rel="noopener noreferrer" hidden>在 Solana Explorer 查看交易</a>
  </section>

  <section class="card" aria-labelledby="payer-heading">
    <h2 id="payer-heading">1. 連接 Petty Cash</h2>
    <p>請在 <strong>Chrome</strong> 的 Phantom 選擇 <strong>Petty Cash</strong>，並關閉 Testnet Mode。付款地址必須是：</p>
    <code id="wallet" class="address">正在讀取地址…</code>
    <button id="connect" type="button" disabled>連接 Phantom 的 Petty Cash</button>
    <p id="connected" class="muted" aria-live="polite">尚未連接付款錢包。</p>
  </section>

  <section class="card" aria-labelledby="quote-heading">
    <h2 id="quote-heading">2. 取得報價，核對交易</h2>
    <p>按一次以下按鈕，取得目前報價並由 Gate 檢查交易。這一步會準備與模擬交易，不會送出交易。</p>
    <button id="quote" type="button" disabled>取得 0.001 SOL → USDC 報價</button>
    <div id="review" hidden>
      <dl>
        <dt>交換金額</dt><dd id="input"></dd>
        <dt>報價預計收到</dt><dd id="output"></dd>
        <dt>最少收到</dt><dd id="minimum"></dd>
        <dt>Gate 檢查摘要</dt><dd id="summary"></dd>
        <dt>模擬 SOL 流出</dt><dd id="outflow"></dd>
        <dt>模擬代幣流入</dt><dd id="inflow"></dd>
      </dl>
      <p class="notice">請核對 Phantom 顯示的付款與收款內容。0.001 SOL 是交換金額；手續費與首次建立 USDC 帳戶可能另外使用 SOL。Gate 設定的本次 SOL 流出上限是 0.003 SOL。報價會隨時間改變。</p>
      <div id="warning-box" hidden><strong>Gate 提醒</strong><ul id="warnings"></ul></div>
      <details><summary>查看交易識別碼</summary><p class="muted">交易內容的 SHA-256：</p><code id="hash" class="address"></code></details>
      <button id="sign" type="button" disabled>核對完成，用 Petty Cash 簽署</button>
      <button id="cancel" class="secondary" type="button" disabled>取消這份報價</button>
      <p class="muted">Phantom 這次請你簽署的是付款交易；Gate 核准會在下一步另外進行。</p>
    </div>
  </section>

  <section id="approval" class="card" aria-labelledby="approval-heading" hidden>
    <h2 id="approval-heading">3. 到 Gate Approver 的 Chrome 視窗核准</h2>
    <p>請先在另一個 Chrome Profile 的 Phantom 準備 Gate Approver，保持解鎖並開好核准頁。付款簽完後立即操作：</p>
    <ol>
      <li>切到已準備好的 Gate Approver 視窗；兩個 Profile 各自使用 Phantom。</li>
      <li>確認地址與下方完全一致。</li>
      <li>按「開啟 Gate 核准頁」。若暫時沒有待核准交易，等幾秒讓頁面更新。</li>
      <li>核對同一筆 0.001 SOL → USDC 交易，按 <strong>Approve with wallet</strong>，再在 Phantom 核准訊息簽名。</li>
    </ol>
    <code id="approver" class="address"></code>
    <a id="approval-link" class="button-link" target="_blank" rel="noopener noreferrer" hidden>開啟 Gate 核准頁</a>
    <p class="notice">付款簽署與 Gate 核准共用同一個安全倒數，從收到報價起開始，切換帳號不會重新計時。請在倒數結束前完成兩次簽署。</p>
  </section>
</main>
</body>
</html>`;

export const APP_JS = String.raw`(() => {
  'use strict';
  const EXPECTED_WALLET = 'J3rFAMrr2GDNhDg2x3Cn2K9iNKyrGh4WcqbmNG9xKaRj';
  const EXPECTED_APPROVER = '6N7UYBzKmdHYtUssw45QDbGd1No2xUVTFkkVwnovTd3M';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const session = new URLSearchParams(location.hash.slice(1)).get('session');
  const el = (id) => document.getElementById(id);
  let state = null;
  let busy = false;
  let connected = false;
  let signatureSent = false;
  let signedOrderId = null;
  let pollBusy = false;
  let pollTimer = null;
  let provider = null;
  let stateHealthy = false;
  let providerListenersAdded = false;

  const text = (id, value) => { el(id).textContent = String(value ?? ''); };
  const fail = (message) => { text('error', message); el('error').hidden = false; };
  const clearError = () => { text('error', ''); el('error').hidden = true; };
  const describeError = (error) => {
    if (error?.code === 4001) return signatureSent
      ? '你已取消 Phantom 的請求。先前提交的交易仍可能正在處理；請查看目前狀態，不要重複簽署。'
      : '你已取消這次 Phantom 請求。本頁尚未提交本次交易。';
    if (error?.name === 'AbortError') return signatureSent
      ? '等待回覆逾時。請不要重複簽署；本頁會繼續查詢結果。'
      : '本機服務等待逾時。請先確認服務仍在運作。';
    return String(error?.message || '操作未完成。請保留頁面，查看狀態。');
  };
  const amount = (value, decimals) => {
    const raw = String(value);
    if (!/^\d+$/.test(raw)) throw new Error('報價金額格式不正確，請停止操作。');
    const padded = raw.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    return whole + (fraction ? '.' + fraction : '');
  };
  const flows = (values) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return '未提供';
    const entries = Object.entries(values);
    if (!entries.length) return '未提供';
    return entries.map(([mint, value]) => {
      const symbol = mint === 'SOL' ? 'SOL' : mint === USDC || mint === 'USDC' ? 'USDC' : '代幣 ' + mint;
      return String(value) + ' ' + symbol;
    }).join('；');
  };
  const isPendingOrFinished = () => {
    if (signatureSent || state?.result) return true;
    const phase = String(state?.phase || '');
    return phase !== 'quote-refused'
      && /approval|hold|execut|submitt|confirm|complet|finish|fail|unknown|refused|succeeded/i.test(phase);
  };
  const orderExpired = (order) => {
    const deadline = Math.min(Date.parse(order?.expiresAt),
      Date.parse(order?.approvalDeadline ?? order?.expiresAt));
    return !Number.isFinite(deadline) || deadline <= Date.now();
  };
  const expiryMessage = '這份報價已過期，尚未提交交易。請按「重新取得 0.001 SOL → USDC 報價」，核對新報價後再簽署。';
  const signingClosed = (order) => {
    const deadline = Date.parse(order?.signingDeadline ?? order?.approvalDeadline ?? order?.expiresAt);
    return !Number.isFinite(deadline) || deadline <= Date.now();
  };
  const signingClosedMessage = '開始付款簽署的時間已過。請手動重新取得報價，準備好兩個視窗後立即簽署。';
  // Known refusal codes in plain words; the code and stage stay visible for the record.
  const ERROR_TEXT = {
    blockhash_expired: '交易有效期（blockhash）已過，Gate 沒有送出交易，資金沒有移動。請重新取得報價，並連續完成付款簽署與 Gate 核准。',
    rpc_unavailable: 'RPC 暫時無法確認交易有效期，Gate 沒有送出交易。請保留畫面與紀錄，稍後再重新取得報價。',
    order_expired: '這份報價已過本機期限，Gate 沒有送出交易。請重新取得報價。',
    approval_window_expired: '付款簽署與 Gate 核准的共同安全倒數已結束，這筆交易沒有送出。請重新取得報價並連續完成兩次簽署。',
    payment_signature_too_late: '付款簽名超過送達時限，沒有建立 Gate 核准，也沒有送出交易。請手動重新取得報價。',
  };
  const resultText = (result) => {
    const code = typeof result.error === 'string' ? result.error : '';
    if (!code) return '結果：' + String(result.status || '尚未確認') + '。請勿重複送出。';
    const where = code + (typeof result.stage === 'string' && result.stage ? ' @ ' + result.stage : '');
    return ERROR_TEXT[code] ? ERROR_TEXT[code] + '（' + where + '）' : where;
  };
  // This is the server's conservative operation deadline, not a promise of
  // remaining chain validity. Both wallet actions consume the same clock.
  const clockText = (order) => {
    const received = Date.parse(order?.receivedAt);
    if (!Number.isFinite(received)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - received) / 1000));
    if (order.blockhash?.expiredAt) return '報價後第 ' + seconds + ' 秒：鏈上已確認這份報價的交易有效期結束。';
    const deadline = Math.min(Date.parse(order.expiresAt), Date.parse(order.approvalDeadline ?? order.expiresAt));
    if (!Number.isFinite(deadline)) return '目前無法確認本次操作的安全期限，請停止簽署。';
    const remaining = Math.max(0, Date.parse(order.expiresAt) - Date.now()) / 1000;
    if (deadline <= Date.now()) return '本次操作安全倒數已結束。報價後已過 ' + seconds + ' 秒；請重新取得報價。';
    const reserve = Number.isSafeInteger(order.executionReserveMs) && order.executionReserveMs > 0
      ? ' 已預留 ' + (order.executionReserveMs / 1000).toFixed(1) + ' 秒供程式送出。' : '';
    return '本機交易期限：剩約 ' + remaining.toFixed(1) + ' 秒。報價後已過 ' + seconds
      + ' 秒；付款簽署與 Gate 核准共用期限。' + reserve;
  };

  async function api(path, body, timeoutMs = 10000) {
    if (!session || !/^[a-f0-9]{32,128}$/i.test(session)) throw new Error('本機連線憑證缺失。請使用完整的本機連結重新開啟頁面。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-SFGate-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(typeof data?.error === 'string' ? data.error : '本機服務拒絕操作（' + response.status + '）。');
        error.code = data?.code;
        error.canRequote = data?.canRequote === true;
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  function safeLink(id, raw, kind) {
    const node = el(id);
    node.hidden = true;
    node.removeAttribute('href');
    if (!raw) return;
    try {
      const url = new URL(raw);
      const allowed = kind === 'approval'
        ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '8787' && !url.username && !url.password
        : url.protocol === 'https:' && url.hostname === 'explorer.solana.com' && url.pathname.startsWith('/tx/') && !url.username && !url.password;
      if (allowed) { node.href = url.href; node.hidden = false; }
    } catch { /* A malformed server link is never activated. */ }
  }

  function render() {
    const ready = stateHealthy && state && state.wallet === EXPECTED_WALLET && state.approver === EXPECTED_APPROVER;
    const disabled = !ready || busy || state?.paused || isPendingOrFinished();
    const orderValid = state?.order && String(state.order.inAmount) === '1000000'
      && /^\d+$/.test(String(state.order.outAmount)) && BigInt(state.order.outAmount) > 0n
      && /^\d+$/.test(String(state.order.otherAmountThreshold)) && BigInt(state.order.otherAmountThreshold) > 0n
      && BigInt(state.order.otherAmountThreshold) <= BigInt(state.order.outAmount)
      && state.order.id && /^[a-f0-9]{64}$/i.test(state.order.review?.messageSha256 || '');
    el('connect').disabled = Boolean(disabled);
    const expired = Boolean(state?.order) && orderExpired(state.order);
    el('quote').disabled = Boolean(disabled || !connected);
    text('quote', state?.order ? '重新取得 0.001 SOL → USDC 報價' : '取得 0.001 SOL → USDC 報價');
    el('sign').disabled = Boolean(disabled || !connected || !orderValid || expired
      || signingClosed(state?.order) || !state?.order?.transaction);
    el('cancel').disabled = Boolean(disabled || !state?.order);
    el('pause-note').hidden = !state?.paused;
    if (!state) return;
    text('wallet', state.wallet);
    text('approver', state.approver);
    const clock = stateHealthy && state.order && !state.result
      && !/submitt|unknown/i.test(String(state.phase || '')) ? clockText(state.order) : '';
    el('clock').hidden = !clock;
    text('clock', clock);
    const statuses = {
      paused: '已暫停，尚未啟動測試。',
      idle: '可以開始連接付款錢包。',
      'quote-pending': '正在取得報價並檢查交易，尚未送出。',
      quoting: '正在取得報價並檢查交易，尚未送出。',
      reviewing: '正在取得報價並檢查交易，尚未送出。',
      'quote-refused': '這份報價未通過 Gate 檢查，尚未簽署或提交交易。',
      'order-ready': '報價與檢查已完成，等待你核對後簽署。',
      'awaiting-signature': '報價與檢查已完成，等待你核對後用 Petty Cash 簽署。',
      ready: '可以連接付款錢包並取得報價。',
      'gate-approval-pending': '正在等待 Gate Approver 核准，請完成下方第 3 步。',
      executing: 'Gate 已核准，正在提交交易。請勿重複操作。',
      submitting: 'Gate 已核准，正在交給 Jupiter 提交交易。請勿重複操作。',
      submitted: 'Jupiter 回報已提交，仍待核對鏈上交易與 Gate 紀錄。',
      confirming: '正在查核交易結果，請保留頁面。',
      complete: '交易處理已結束，請查看下方結果。',
      completed: '交易處理已結束，請查看下方結果。',
      failed: '本次操作未完成，請查看下方訊息。',
      refused: 'Gate 拒絕了本次操作，請查看下方原因。',
      succeeded: 'Jupiter 回報交換成功，仍待核對鏈上交易與 Gate 紀錄。',
      unknown: '交易結果尚未確認，請勿重新執行。',
      'outcome-unknown': '交易結果尚未確認，請勿重新簽署或送出。',
    };
    text('status', state.paused ? statuses.paused : busy && !signatureSent
      ? '正在處理你的操作，請等候…'
      : expired && !isPendingOrFinished() ? expiryMessage
      : state.order && signingClosed(state.order) && !isPendingOrFinished() ? signingClosedMessage
      : statuses[state.phase] || (state.order ? '報價已準備，請核對交易。' : '本機服務已連接。'));
    el('review').hidden = !state.order;
    if (state.order) {
      if (!orderValid) fail('這份報價的金額或檢查資料不符合本次 0.001 SOL 測試，已停用簽署。');
      try {
        text('input', amount(state.order.inAmount, 9) + ' SOL');
        text('output', amount(state.order.outAmount, 6) + ' USDC');
        text('minimum', amount(state.order.otherAmountThreshold, 6) + ' USDC');
      } catch (error) { fail(describeError(error)); el('sign').disabled = true; }
      const review = state.order.review || {};
      text('summary', review.summaryLine || '未提供');
      text('outflow', flows(review.outflow));
      text('inflow', flows(review.inflow));
      text('hash', review.messageSha256 || '未提供');
      el('warnings').replaceChildren();
      const warnings = Array.isArray(review.warnings) ? review.warnings : [];
      for (const warning of warnings) {
        const row = document.createElement('li');
        row.textContent = typeof warning === 'string' ? warning : JSON.stringify(warning);
        el('warnings').appendChild(row);
      }
      el('warning-box').hidden = !warnings.length;
    }
    const needsApproval = signatureSent || state.phase === 'gate-approval-pending';
    el('approval').hidden = !needsApproval || Boolean(state.result);
    safeLink('approval-link', state.approvalUrl, 'approval');
    el('result').hidden = !state.result;
    if (state.result) {
      const result = state.result;
      const resultStatus = String(result.status).toLowerCase();
      const success = ['success', 'succeeded', 'confirmed', 'finalized', 'completed'].includes(resultStatus);
      const submitted = resultStatus === 'submitted';
      el('result').className = success ? 'success' : 'notice';
      text('result', success
        ? 'Jupiter 回報交換成功，仍待核對鏈上交易與 Gate 紀錄。' + (result.signature ? ' 交易簽名：' + result.signature : '')
        : submitted
          ? 'Jupiter 回報已提交，仍待核對鏈上交易與 Gate 紀錄。' + (result.signature ? ' 交易簽名：' + result.signature : '')
        : resultText(result) + (result.signature ? ' 候選交易簽名：' + result.signature + '（先查核鏈上結果，不要重送）' : ''));
      safeLink('explorer', result.explorerUrl, 'explorer');
    }
  }

  async function refresh() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const next = await api('/api/state');
      if (next.wallet !== EXPECTED_WALLET || next.approver !== EXPECTED_APPROVER) {
        throw new Error('服務顯示的錢包地址與本次測試不一致，請停止操作。');
      }
      state = next;
      stateHealthy = true;
      render();
    } catch (error) {
      stateHealthy = false;
      fail(describeError(error));
      text('status', '目前無法確認本機服務狀態。請勿重複簽署。');
      ['connect', 'quote', 'sign', 'cancel'].forEach((id) => { el(id).disabled = true; });
    } finally { pollBusy = false; }
  }

  function getProvider() {
    const value = window.phantom?.solana;
    if (!value?.isPhantom || typeof value.connect !== 'function' || typeof value.signTransaction !== 'function') {
      throw new Error('找不到可簽署交易的 Phantom。請用已安裝 Phantom 的 Chrome 開啟此頁並解鎖錢包。');
    }
    return value;
  }

  function payerAddress(value) { return value?.publicKey?.toBase58?.() || value?.publicKey?.toString?.() || ''; }
  function requirePayer(value) {
    if (!state || state.wallet !== EXPECTED_WALLET || payerAddress(value) !== state.wallet) {
      connected = false;
      throw new Error('目前 Phantom 不是 Petty Cash。請切換至 J3r…KaRj，再按「連接 Phantom 的 Petty Cash」。');
    }
  }
  function checkActive() {
    if (!stateHealthy || !state || state.paused || isPendingOrFinished()) throw new Error('本次操作尚未開放，或已進入簽署後的處理階段。請查看目前狀態。');
  }

  async function connect() {
    if (busy) return;
    busy = true;
    clearError();
    render();
    try {
      checkActive();
      provider = getProvider();
      const reply = await provider.connect();
      requirePayer(reply);
      requirePayer(provider);
      connected = true;
      text('connected', '已連接正確的 Petty Cash 付款錢包。');
      if (!providerListenersAdded && typeof provider.on === 'function') {
        provider.on('accountChanged', () => {
          if (signatureSent) return; // Switching to Gate Approver after signing is expected.
          connected = payerAddress(provider) === EXPECTED_WALLET;
          text('connected', connected ? '已連接正確的 Petty Cash 付款錢包。' : 'Phantom 帳號已切換，請重新選 Petty Cash 並連接。');
          render();
        });
        provider.on('disconnect', () => {
          connected = false;
          if (!signatureSent) text('connected', 'Phantom 已斷開，請重新連接 Petty Cash。');
          render();
        });
        providerListenersAdded = true;
      }
    } catch (error) { fail(describeError(error)); }
    finally { busy = false; render(); }
  }

  async function quote() {
    if (busy) return;
    busy = true;
    clearError();
    render();
    try {
      checkActive();
      requirePayer(getProvider());
      await api('/api/order', {}, 90000);
      await refresh();
    } catch (error) { fail(describeError(error)); }
    finally { busy = false; render(); }
  }

  function decodeBase64(value) {
    if (typeof value !== 'string' || !value || value.length > 65536) throw new Error('交易資料格式不正確。');
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error('交易資料不是標準 base64 格式。');
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  function encodeBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function equalBytes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
  async function digest(bytes) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sign() {
    if (busy) return;
    busy = true;
    clearError();
    render();
    try {
      checkActive();
      provider = getProvider();
      requirePayer(provider);
      const order = state.order;
      if (!order || String(order.inAmount) !== '1000000' || !order.id || !/^[a-f0-9]{64}$/i.test(order.review?.messageSha256 || '')
        || !/^\d+$/.test(String(order.outAmount)) || !/^\d+$/.test(String(order.otherAmountThreshold))
        || BigInt(order.otherAmountThreshold) <= 0n || BigInt(order.otherAmountThreshold) > BigInt(order.outAmount)) {
        throw new Error('交易金額或檢查資料不完整。請停止簽署。');
      }
      if (orderExpired(order)) throw new Error(expiryMessage);
      if (signingClosed(order)) throw new Error(signingClosedMessage);
      if (!window.solanaWeb3?.VersionedTransaction) throw new Error('本機交易工具尚未載入，請等待或重新開啟頁面。');
      const transaction = window.solanaWeb3.VersionedTransaction.deserialize(decodeBase64(order.transaction));
      const message = transaction.message.serialize();
      if (await digest(message) !== order.review.messageSha256.toLowerCase()) throw new Error('交易內容與 Gate 檢查的內容不一致，已阻止簽署。');
      const keys = transaction.message.staticAccountKeys;
      const required = transaction.message.header.numRequiredSignatures;
      const payerIndex = keys.slice(0, required).findIndex((key) => key.toBase58() === EXPECTED_WALLET);
      if (payerIndex < 0 || keys[0]?.toBase58() !== EXPECTED_WALLET) throw new Error('交易付款錢包不正確，已阻止簽署。');
      if (orderExpired(order)) throw new Error(expiryMessage);
      if (signingClosed(order)) throw new Error(signingClosedMessage);
      text('status', '請在 Phantom 核對付款交易，再決定是否簽署。');
      const signed = await provider.signTransaction(transaction);
      requirePayer(provider);
      if (orderExpired(order)) throw new Error(expiryMessage);
      const paymentDeadline = Date.parse(order.paymentSubmissionDeadline ?? order.approvalDeadline ?? order.expiresAt);
      if (!Number.isFinite(paymentDeadline) || Date.now() > paymentDeadline) throw new Error(ERROR_TEXT.payment_signature_too_late);
      if (!signed?.message || !equalBytes(message, signed.message.serialize())) throw new Error('Phantom 回傳的交易內容有變更，已阻止提交。');
      if (!signed.signatures?.[payerIndex]?.some((byte) => byte !== 0)) throw new Error('沒有取得 Petty Cash 的交易簽名。');
      // Lock this order before POST; an unknown response must never lead to retry.
      signedOrderId = order.id;
      signatureSent = true;
      text('connected', 'Petty Cash 已簽署交易。接下來請到 Gate Approver 的 Chrome 視窗核准。');
      render();
      const submission = api('/api/signature', { id: signedOrderId, signedTransaction: encodeBase64(signed.serialize()) }, 130000);
      text('status', '交易簽署已交給 Gate，請立即完成下方第 3 步的核准。');
      await submission;
      await refresh();
    } catch (error) {
      // Only an explicit server refusal before it accepted payment can unlock
      // a manual new quote. Lost replies and unknown outcomes stay locked.
      if (error.canRequote && ['payment_signature_too_late', 'order_expired',
        'approval_window_expired', 'blockhash_expired'].includes(error.code)) {
        signatureSent = false;
        signedOrderId = null;
        await refresh();
      }
      fail(describeError(error));
    }
    finally { busy = false; render(); }
  }

  async function cancel() {
    if (busy) return;
    busy = true;
    clearError();
    render();
    try {
      checkActive();
      if (!state?.order?.id) throw new Error('目前沒有可取消的報價。');
      await api('/api/cancel', { id: state.order.id });
      await refresh();
    } catch (error) { fail(describeError(error)); }
    finally { busy = false; render(); }
  }

  el('connect').addEventListener('click', connect);
  el('quote').addEventListener('click', quote);
  el('sign').addEventListener('click', sign);
  el('cancel').addEventListener('click', cancel);
  if (!session || !/^[a-f0-9]{32,128}$/i.test(session)) {
    fail('本機連線憑證缺失。請使用完整的本機連結重新開啟頁面。');
    text('status', '目前無法連接本機服務。');
  } else {
    refresh();
    pollTimer = setInterval(refresh, 500);
    window.addEventListener('pagehide', () => { clearInterval(pollTimer); });
  }
})();`;
