import { useEffect, useRef, useState } from 'react';
import api from '../services/api.js';
import {
  blockedCombo,
  enterSecureMode,
  fullscreenSupported,
  isFullscreen,
  leaveSecureMode,
} from '../utils/secureMode.js';

/**
 * Keeps a playing team in secure mode:
 *   - blocks the keys listed in utils/secureMode.js (the Round 2 page, an iframe, reports its
 *     blocked keys to us with postMessage),
 *   - asks the player to go back to fullscreen when they leave it (full-page overlay),
 *   - reports blocked keys, leaving the window and leaving fullscreen to the server, where the
 *     host sees them in Team Logs.
 *
 * `active` is true only while a team is in the game; the host console is never affected.
 */
export default function SecureModeGuard({ active, inGame = active, teamId }) {
  const [enabled, setEnabled] = useState(null); // null = not asked yet
  const [fullscreen, setFullscreen] = useState(isFullscreen());
  // the browser refused fullscreen after a click: never trap the player, play on (it is logged)
  const [refused, setRefused] = useState(false);
  const lastSent = useRef({});

  // the host's switch (CHRONOS_SECURE_MODE) is read once when a team enters the game
  useEffect(() => {
    if (!active || enabled !== null) return undefined;
    let cancelled = false;
    api.getSecurityConfig().then((on) => {
      if (!cancelled) setEnabled(on);
    });
    return () => {
      cancelled = true;
    };
  }, [active, enabled]);

  const on = Boolean(active && enabled);

  useEffect(() => {
    if (!on || !teamId) return undefined;

    const report = (kind, detail = '') => {
      const key = `${kind}:${detail}`;
      const now = Date.now();
      if (now - (lastSent.current[key] || 0) < 3000) return;
      lastSent.current[key] = now;
      api.reportSecurityEvent(teamId, kind, detail);
    };

    const onKeyDown = (e) => {
      const combo = blockedCombo(e);
      if (!combo) return;
      e.preventDefault(); // Esc and the like still reach the game's own handlers (no stopPropagation)
      report('KEY_BLOCKED', combo);
    };
    const onContextMenu = (e) => e.preventDefault();
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const checkFocus = () => {
      // an iframe (Round 2) holding the focus is fine; another window or tab is not
      window.setTimeout(() => {
        if (document.visibilityState === 'hidden') report('FOCUS_LOST', 'tab hidden');
        else if (!document.hasFocus()) report('FOCUS_LOST', 'window not focused');
      }, 200);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') report('FOCUS_LOST', 'tab hidden');
    };
    const onFullscreen = () => {
      const full = isFullscreen();
      setFullscreen(full);
      if (full) setRefused(false);
      if (full) enterSecureMode(); // re-lock the keyboard after coming back
      else report('FULLSCREEN_EXIT');
    };
    const onMessage = (e) => {
      if (e.origin === window.location.origin && e.data?.type === 'chronos-key-blocked') {
        report('KEY_BLOCKED', String(e.data.combo || '').slice(0, 40));
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('blur', checkFocus);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('message', onMessage);
    setFullscreen(isFullscreen());

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('blur', checkFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('message', onMessage);
    };
  }, [on, teamId]);

  // leaving the game (logout, host console) releases fullscreen and the keyboard; moving
  // between screens inside the game (inGame stays true) never does
  useEffect(() => {
    if (!inGame) leaveSecureMode();
  }, [inGame]);

  // tell the host when this browser cannot lock the keyboard (Firefox, Safari, old Chrome):
  // Ctrl+W, Alt+F4, Alt+Tab and the Windows key cannot be blocked there
  useEffect(() => {
    if (on && teamId && !(navigator.keyboard && navigator.keyboard.lock)) {
      api.reportSecurityEvent(teamId, 'LOCK_UNAVAILABLE', 'browser has no keyboard lock');
    }
  }, [on, teamId]);

  const giveBack = async () => {
    const ok = await enterSecureMode();
    if (!ok && teamId) {
      setRefused(true);
      api.reportSecurityEvent(teamId, 'FULLSCREEN_EXIT', 'browser refused fullscreen');
    }
  };

  if (!on || fullscreen || refused || !fullscreenSupported()) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#05070c]/95 p-6 text-center"
      role="alertdialog"
      aria-modal="true"
      aria-label="Return to fullscreen"
    >
      <div className="max-w-md space-y-5 rounded-2xl border border-rose-500/60 bg-[#070c18] p-8 shadow-[0_0_50px_rgba(244,63,94,0.25)]">
        <div className="font-mono text-xs uppercase tracking-[0.3em] text-rose-300">Secure mode</div>
        <h2 className="font-tech text-2xl font-bold tracking-wide text-white">Fullscreen is required</h2>
        <p className="font-mono text-sm leading-relaxed text-slate-300">
          The game must stay in fullscreen. Your time keeps running.
        </p>
        <button
          type="button"
          onClick={giveBack}
          className="w-full cursor-pointer rounded-xl border border-cyan-200 bg-gradient-to-r from-cyan-400 to-teal-300 px-6 py-3 font-tech text-base font-bold uppercase tracking-widest text-slate-950 shadow-[0_0_30px_rgba(6,182,212,0.5)] transition hover:scale-[1.02]"
        >
          Return to fullscreen
        </button>
      </div>
    </div>
  );
}
