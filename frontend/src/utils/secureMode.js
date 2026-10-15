/**
 * Secure mode helpers: fullscreen + Keyboard Lock + a list of keys the game never lets through.
 *
 * What a web page can and cannot do:
 *   - In Chrome / Edge, inside fullscreen, navigator.keyboard.lock() hands the page keys the
 *     browser would normally keep (Alt+Tab, Esc, Ctrl+W, the Windows key ...).
 *   - Ctrl+Alt+Del, Win+L and closing the window from the task manager can never be blocked
 *     by a web page.
 * The host can turn the whole thing off with CHRONOS_SECURE_MODE=0 (GET /api/security/config).
 */

const FUNCTION_BLOCKED = new Set(['F11', 'F12']);
const CTRL_BLOCKED = new Set(['w', 't', 'n', 'u', 's', 'p', 'z', 'y', 'x', 'tab']);
const CTRL_SHIFT_BLOCKED = new Set(['i', 'j', 'c', 'n', 't', 'w', 'tab']);

/** Name of the blocked combination for this key event, or '' when the key is allowed. */
export function blockedCombo(e) {
  const key = String(e.key || '');
  const k = key.toLowerCase();

  if (key === 'Meta' || key === 'OS' || e.code === 'MetaLeft' || e.code === 'MetaRight') return 'Windows key';
  if (FUNCTION_BLOCKED.has(key)) return key;
  if (key === 'Escape') return 'Esc';
  if (e.altKey && (k === 'tab' || key === 'F4')) return `Alt+${key === 'F4' ? 'F4' : 'Tab'}`;
  if (e.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) return `Alt+${key.replace('Arrow', '')}`;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && CTRL_SHIFT_BLOCKED.has(k)) return `Ctrl+Shift+${key.toUpperCase()}`;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && CTRL_BLOCKED.has(k)) return `Ctrl+${k === 'tab' ? 'Tab' : key.toUpperCase()}`;
  return '';
}

export const fullscreenSupported = () => Boolean(document.documentElement.requestFullscreen);
export const isFullscreen = () => Boolean(document.fullscreenElement);

/** Must be called from a click / key press (browsers require a user gesture for fullscreen). */
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

export async function enterSecureMode() {
  try {
    if (fullscreenSupported() && !document.fullscreenElement) {
      // some embedded browsers never answer: do not wait for ever
      await withTimeout(document.documentElement.requestFullscreen({ navigationUI: 'hide' }), 2000);
    }
  } catch {
    // refused (no user gesture, or not allowed): the overlay asks again
  }
  try {
    if (navigator.keyboard && navigator.keyboard.lock && isFullscreen()) {
      await withTimeout(navigator.keyboard.lock(), 1500);
    }
  } catch {
    // Keyboard Lock needs Chrome / Edge and fullscreen: the key handlers still apply
  }
  return isFullscreen();
}

export function leaveSecureMode() {
  try {
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  } catch {
    // ignore
  }
  try {
    if (document.fullscreenElement) document.exitFullscreen();
  } catch {
    // ignore
  }
}
