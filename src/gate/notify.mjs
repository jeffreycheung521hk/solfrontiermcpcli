// Tell the human a transaction is waiting (SPEC §5.6).
//
// Best effort only: a missing binary, a headless box or a sandbox that forbids
// spawning must never throw into the pipeline and never block it. The hold is
// waiting on the approval page either way; a notification just shortens the
// time until someone looks.
import { spawn as childSpawn } from 'node:child_process';
import process from 'node:process';

// Only ever open our own loopback page. `open` / `xdg-open` will happily
// launch a file:// path or a custom URL scheme, so anything else is dropped.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}(\/[A-Za-z0-9._~\/#?=&-]*)?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Quote-safe text for the inside of an AppleScript string literal. */
export function escapeAppleScript(text) {
  return String(text ?? '').replace(CONTROL, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function launch(spawn, command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child?.on?.('error', () => {}); // ENOENT and friends arrive asynchronously
    child?.unref?.();
  } catch {
    // Best effort: a spawn that throws synchronously is as good as no notifier.
  }
}

/**
 * Show a desktop notification and open the approval page. Never throws.
 *
 * @param {object} options
 * @param {string} [options.title]    defaults to "SolFrontier Gate"
 * @param {string} [options.body]
 * @param {string} [options.url]      the loopback approval page; anything else is not opened
 * @param {boolean} [options.enabled] false ⇒ do nothing
 * @param {boolean} [options.openUrl] false ⇒ notify only (config `approval.openBrowser`)
 * @param {string} [options.platform] injectable for tests
 * @param {Function} [options.spawn]  injectable for tests
 */
export function notifyHold({
  title = 'SolFrontier Gate',
  body = '',
  url,
  enabled = true,
  openUrl = true,
  platform = process.platform,
  spawn = childSpawn,
} = {}) {
  try {
    if (!enabled) return;
    const target = openUrl && typeof url === 'string' && LOOPBACK_URL.test(url) ? url : null;
    if (platform === 'darwin') {
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
      launch(spawn, 'osascript', ['-e', script]);
      if (target) launch(spawn, 'open', [target]);
    } else if (platform === 'linux') {
      if (target) launch(spawn, 'xdg-open', [target]);
    }
  } catch {
    // Never throws, never blocks.
  }
}
