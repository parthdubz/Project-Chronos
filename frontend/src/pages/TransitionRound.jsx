import { useState, useEffect, useId } from 'react';
import {
  Clock,
  Play,
  Square,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Eye,
  EyeOff,
  ArrowRight,
  Check,
  Lock,
  Footprints,
  LogOut,
} from 'lucide-react';
import { soundFx } from '../utils/audio.js';
import { useStopwatch, formatElapsed } from '../hooks/useStopwatch.js';
import { getClueById } from '../data/transitionClues.js';
import api from '../services/api.js';

/**
 * Physical Transition Round — frontend-only prototype between the Round 1 lobby and Round 2.
 *
 * The destination and the password are PHYSICAL. The registered team gets one clue, has to
 * work out where it points, goes there, and brings back a password. The backend
 * (/api/transition/*) assigns the clue, checks the password, enforces the 3 attempts and
 * scores the round. No zone or destination name is ever displayed or sent to the client.
 *
 * Without a team session (standalone /transition, used by run-transition.bat) the page runs
 * in DEMO mode: a built-in clue, the local dummy password, no scoring.
 *
 * Workflow state (stage):
 *   clue_demo -> timer_running -> password_entry -> verification_success (Round 2 handoff)
 */

// DEMO mode only (no team session). Live teams are verified by the backend.
const DEMO_PASSWORD = 'dummy';
const DEMO_CLUE_ID = 0;

const STEPS = [
  { id: 'clue_demo', label: 'Clue Briefing' },
  { id: 'timer_running', label: 'Stopwatch' },
  { id: 'password_entry', label: 'Credential' },
  { id: 'verification_success', label: 'Access' },
];

const primaryBtn =
  'inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl font-tech font-bold tracking-widest uppercase text-slate-950 bg-gradient-to-r from-cyan-400 via-cyan-300 to-pink-400 border border-cyan-200 shadow-[0_0_28px_rgba(6,182,212,0.45)] hover:shadow-[0_0_40px_rgba(6,182,212,0.7)] hover:scale-[1.02] active:scale-95 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:shadow-none';
const fieldCls =
  'w-full rounded-lg bg-[#03060f] border border-cyan-900/70 px-3 py-2.5 font-mono text-sm sm:text-base text-cyan-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition';
const panelCls =
  'relative overflow-hidden rounded-2xl border border-cyan-800/60 bg-[#070c18]/95 backdrop-blur-xl shadow-[0_0_50px_rgba(6,182,212,0.12)] p-5 sm:p-8';

function PanelAccent() {
  return (
    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-400 via-pink-500 to-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.7)]" />
  );
}

function Stepper({ stage }) {
  const activeIndex = STEPS.findIndex((s) => s.id === stage);
  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 mb-5" aria-label="Transition progress">
      {STEPS.map((step, i) => {
        const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'locked';
        return (
          <li
            key={step.id}
            aria-current={state === 'active' ? 'step' : undefined}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[0.8125rem] sm:text-xs font-mono uppercase tracking-wider ${
              state === 'active'
                ? 'border-cyan-400 bg-cyan-950/70 text-cyan-200 shadow-[0_0_14px_rgba(6,182,212,0.35)]'
                : state === 'done'
                  ? 'border-emerald-700/70 bg-emerald-950/40 text-emerald-300'
                  : 'border-slate-800 bg-slate-950/60 text-slate-600'
            }`}
          >
            {state === 'done' ? <Check className="w-3 h-3" /> : state === 'locked' ? <Lock className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-cyan-300 animate-pulse" />}
            <span>{i + 1}. {step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ClueCard({ teamName, clue }) {
  return (
    <article className="rounded-xl border border-cyan-900/60 bg-[#03060f]/90 p-4 sm:p-6 text-left space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-950 pb-2.5 font-mono text-[0.8125rem] sm:text-xs uppercase tracking-widest">
        <span className="text-cyan-300 font-bold text-sm">{teamName}</span>
        <span className="text-pink-300">Your clue</span>
      </header>
      <p className="font-tech text-xl sm:text-2xl leading-relaxed text-slate-100 whitespace-pre-line">{clue.text}</p>
    </article>
  );
}

function PhysicalNotice({ children }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-pink-900/60 bg-pink-950/20 p-3.5 text-left">
      <Footprints className="w-5 h-5 text-pink-400 shrink-0 mt-0.5" />
      <p className="font-mono text-xs sm:text-sm text-pink-100/90 leading-relaxed">{children}</p>
    </div>
  );
}

export default function TransitionRound({ teamId, teamName, onProceedToRound2, onLogout }) {
  const [stage, setStage] = useState('clue_demo');
  const [recordedMs, setRecordedMs] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [attemptsRemaining, setAttemptsRemaining] = useState(3);
  const [locked, setLocked] = useState(false);
  const [clueId, setClueId] = useState(teamId ? null : DEMO_CLUE_ID);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [stopError, setStopError] = useState('');
  const stopwatch = useStopwatch();
  const { resume: resumeStopwatch, freeze: freezeStopwatch } = stopwatch; // stable callbacks
  const uid = useId();

  const live = Boolean(teamId);
  const clue = clueId === null ? null : getClueById(clueId);
  const callsign = teamName || 'YOUR TEAM';

  // Live team: load the clue and attempt state from the backend (also restores a finished round).
  useEffect(() => {
    if (!live) return undefined;
    let cancelled = false;
    api.getTransitionState(teamId)
      .then((state) => {
        if (cancelled) return;
        setClueId(state.clue_id);
        setAttempts(state.attempts_used);
        setAttemptsRemaining(state.attempts_remaining);
        if (state.status === 'COMPLETED') {
          setLocked(state.locked);
          if (state.started && state.elapsed_ms != null) setRecordedMs(state.elapsed_ms);
          setStage('verification_success');
        } else if (state.started && state.stopped) {
          // Reloaded after END STOPWATCH: the recorded time is frozen, passkey screen.
          setRecordedMs(state.elapsed_ms ?? null);
          freezeStopwatch(state.elapsed_ms ?? 0);
          setStage('password_entry');
        } else if (state.started) {
          // Reloaded while the stopwatch runs: it carries on from the server's value.
          resumeStopwatch(state.elapsed_ms ?? 0);
          setStage('timer_running');
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'Could not load the transition round.');
      });
    return () => { cancelled = true; };
  }, [live, teamId, resumeStopwatch, freezeStopwatch]);

  const startStopwatch = async () => {
    if (stopwatch.status !== 'idle' || busy || !clue) return;
    if (live) {
      setBusy(true);
      try {
        await api.startTransition(teamId);
      } catch (err) {
        setLoadError(err.message || 'Could not start the transition round.');
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    soundFx.playAccessGranted();
    stopwatch.start();
    setStage('timer_running');
  };

  const endStopwatch = async () => {
    if (stopwatch.status !== 'running' || busy) return;
    let ms = null;
    if (live) {
      // The server freezes the time first: only then is it safe to leave this screen,
      // otherwise a reload would find the stopwatch still running.
      setBusy(true);
      setStopError('');
      try {
        const res = await api.stopTransition(teamId);
        ms = res.elapsed_ms ?? null;
      } catch (err) {
        setStopError(err.message || 'Could not stop the stopwatch. Try again.');
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const localMs = stopwatch.stop();
    setRecordedMs(ms ?? localMs);
    soundFx.playDataPing();
    setStage('password_entry');
  };

  const reject = (message) => {
    setPasswordError(message);
    soundFx.playGlitch();
  };

  const verifyPassword = async (e) => {
    e.preventDefault();
    if (busy) return;
    const entered = password.trim();
    if (!entered) {
      reject('Enter the password you found at your physical destination.');
      return;
    }

    if (!live) {
      setAttempts((n) => n + 1);
      if (entered === DEMO_PASSWORD) {
        setPasswordError('');
        soundFx.playAccessGranted();
        setStage('verification_success');
      } else {
        reject('Credential rejected. Re-check the object at your destination and try again.');
      }
      return;
    }

    setBusy(true);
    try {
      const res = await api.verifyTransitionPassword(teamId, entered);
      setAttempts(res.attempts_used);
      setAttemptsRemaining(res.attempts_remaining);
      if (res.completed) {
        setPasswordError('');
        setLocked(res.locked);
        if (res.correct) soundFx.playAccessGranted(); else soundFx.playGlitch();
        setStage('verification_success');
      } else {
        reject(`Credential rejected. ${res.attempts_remaining} attempt${res.attempts_remaining === 1 ? '' : 's'} remaining.`);
      }
    } catch (err) {
      reject(err.message || 'Verification failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const finalDisplay = recordedMs === null && stopwatch.status === 'idle'
    ? null // restored after a reload: the stopwatch value is not kept
    : formatElapsed(recordedMs ?? stopwatch.elapsedMs);

  const renderClue = () => (
    <div className={`${panelCls} space-y-5`}>
      <PanelAccent />
      <div className="text-center space-y-2">
        <div className="font-mono text-xs sm:text-sm tracking-[0.4em] text-cyan-400">PROJECT CHRONOS</div>
        <h1 className="font-title text-3xl sm:text-5xl text-cyan-200 glow-cyan tracking-wide leading-tight">
          TEMPORAL TRANSITION PROTOCOL
        </h1>
        <p className="font-mono text-sm text-slate-300 leading-relaxed max-w-2xl mx-auto">
          Decode the clue, work out where it points, and retrieve the password hidden there.
        </p>
      </div>
      {loadError ? (
        <p role="alert" className="rounded-xl border border-rose-800/70 bg-rose-950/30 p-4 font-mono text-sm text-rose-200">
          {loadError}
        </p>
      ) : clue ? (
        <ClueCard teamName={callsign} clue={clue} />
      ) : (
        <p className="text-center font-mono text-sm text-cyan-400 animate-pulse">DECRYPTING CLUE...</p>
      )}
      <PhysicalNotice>
        Your destination is a real place in the venue. Nothing on this screen tells you where it is: solve
        the clue, walk there, and find the object it describes. The password is placed at that location.
      </PhysicalNotice>
      <div className="flex justify-center">
        <button
          type="button"
          className={`${primaryBtn} w-full sm:w-auto`}
          onClick={startStopwatch}
          disabled={!clue || busy}
        >
          <Play className="w-5 h-5 fill-current" />
          START STOPWATCH
        </button>
      </div>
    </div>
  );

  const renderRunning = () => (
    <div className={`${panelCls} space-y-6`}>
      <PanelAccent />
      <div className="text-center space-y-3">
        <div className="font-mono text-xs tracking-[0.3em] text-emerald-300 flex items-center justify-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> STOPWATCH RUNNING
        </div>
        <div
          className="font-mono font-bold text-5xl sm:text-7xl lg:text-8xl tracking-widest text-cyan-200 glow-cyan tabular-nums"
          role="timer"
          aria-label={`Elapsed time ${stopwatch.display}`}
        >
          {stopwatch.display}
        </div>
        <div className="font-mono text-[0.8125rem] uppercase tracking-widest text-slate-500">HH : MM : SS</div>
      </div>
      {clue && <ClueCard teamName={callsign} clue={clue} />}
      <PhysicalNotice>
        Find the destination, retrieve the password, then end the stopwatch to enter it.
      </PhysicalNotice>
      {stopError && (
        <p role="alert" className="rounded-xl border border-rose-800/70 bg-rose-950/30 p-3 text-center font-mono text-sm text-rose-200">
          {stopError}
        </p>
      )}
      <div className="flex justify-center">
        <button
          type="button"
          disabled={busy}
          onClick={endStopwatch}
          className="inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-xl font-tech font-bold tracking-widest uppercase text-white bg-rose-700 hover:bg-rose-600 border border-rose-400 shadow-[0_0_28px_rgba(244,63,94,0.4)] active:scale-95 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Square className="w-5 h-5 fill-current" />
          END STOPWATCH
        </button>
      </div>
    </div>
  );

  const renderPassword = () => (
    <div className={`${panelCls} space-y-6 max-w-2xl mx-auto`}>
      <PanelAccent />
      <div className="text-center space-y-3">
        <KeyRound className="w-9 h-9 text-cyan-300 mx-auto" />
        <h2 className="font-title text-2xl sm:text-4xl text-cyan-200 glow-cyan leading-tight">
          TEMPORAL ACCESS VERIFICATION
        </h2>
        <p className="font-mono text-sm text-slate-300 leading-relaxed">
          Enter the password you found at the physical destination of your clue.
        </p>
        <p className="font-mono text-xs text-slate-500 uppercase tracking-widest">
          Recorded time <span className="text-cyan-300">{finalDisplay}</span>
          {live && <> · Attempts remaining <span className="text-cyan-300">{attemptsRemaining}</span></>}
        </p>
      </div>
      <form onSubmit={verifyPassword} className="space-y-4" noValidate>
        <label className="block space-y-1.5" htmlFor={`${uid}-password`}>
          <span className="font-mono text-[0.8125rem] uppercase tracking-widest text-slate-400">Password</span>
          <div className="relative">
            <input
              id={`${uid}-password`}
              type={showPassword ? 'text' : 'password'}
              className={`${fieldCls} pr-11 text-center tracking-[0.25em] uppercase ${passwordError ? 'border-rose-500 focus:border-rose-400 focus:ring-rose-400' : ''}`}
              value={password}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              aria-invalid={Boolean(passwordError)}
              aria-describedby={passwordError ? `${uid}-password-error` : undefined}
              onChange={(e) => {
                // Letters are always capitals, digits stay as typed. The caret is put back so
                // typing in the middle of the password does not jump to the end.
                const input = e.target;
                const caret = input.selectionStart;
                setPassword(input.value.toUpperCase());
                if (passwordError) setPasswordError('');
                requestAnimationFrame(() => {
                  try { input.setSelectionRange(caret, caret); } catch { /* password type: ignore */ }
                });
              }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-slate-400 hover:text-white cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </label>
        <div id={`${uid}-password-error`} role="alert" aria-live="assertive">
          {passwordError && (
            <p className="flex items-start gap-2 rounded-lg border border-rose-800/70 bg-rose-950/30 px-3 py-2.5 font-mono text-xs sm:text-sm text-rose-200">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{passwordError}</span>
            </p>
          )}
        </div>
        {attempts > 0 && passwordError && (
          <p className="text-center font-mono text-[0.8125rem] uppercase tracking-widest text-slate-500">
            Failed attempts: {attempts}
          </p>
        )}
        <button type="submit" className={`${primaryBtn} w-full`} disabled={busy}>
          <ShieldCheck className="w-5 h-5" />
          {busy ? 'VERIFYING...' : 'VERIFY CREDENTIAL'}
        </button>
      </form>
    </div>
  );

  const renderSuccess = () => (
    <div className={`${panelCls} text-center space-y-6 max-w-2xl mx-auto border-emerald-600/70`}>
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-cyan-300 to-emerald-400" />
      <div className="mx-auto w-20 h-20 rounded-full border-2 border-emerald-400 bg-emerald-950/60 flex items-center justify-center shadow-[0_0_40px_rgba(16,185,129,0.5)] animate-pulse">
        {locked ? <ShieldAlert className="w-10 h-10 text-amber-300" /> : <ShieldCheck className="w-10 h-10 text-emerald-300" />}
      </div>
      <div className="space-y-2" role="status" aria-live="polite">
        <h2 className={`font-title text-3xl sm:text-5xl leading-tight ${locked ? 'text-amber-300' : 'text-emerald-300'}`}>
          {locked ? 'TRANSITION CLOSED' : 'TEMPORAL ACCESS GRANTED'}
        </h2>
        <p className="font-mono text-sm text-slate-300">
          {locked
            ? 'No attempts remaining. Continue to Round 2.'
            : 'Credential accepted. The transition is complete.'}
        </p>
      </div>
      {finalDisplay && (
      <div className="rounded-xl border border-emerald-900/70 bg-[#03060f]/90 p-4 inline-block min-w-[16rem]">
        <div className="font-mono text-[0.8125rem] uppercase tracking-widest text-slate-400 flex items-center justify-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-emerald-400" /> Recorded duration
        </div>
        <div className="font-mono font-bold text-4xl sm:text-5xl text-emerald-200 tabular-nums tracking-widest mt-1">
          {finalDisplay}
        </div>
      </div>
      )}
      <div>
        <button
          type="button"
          className={`${primaryBtn} w-full sm:w-auto`}
          disabled={!onProceedToRound2}
          onClick={() => {
            soundFx.playAccessGranted();
            onProceedToRound2?.();
          }}
        >
          PROCEED TO ROUND 2 <ArrowRight className="w-5 h-5" />
        </button>
        {!onProceedToRound2 && (
          <p className="mt-3 font-mono text-xs text-amber-300">Round 2 entry point is not connected in this build.</p>
        )}
      </div>
    </div>
  );

  const stages = {
    clue_demo: renderClue,
    timer_running: renderRunning,
    password_entry: renderPassword,
    verification_success: renderSuccess,
  };

  return (
    <div className="relative min-h-[calc(100vh-2.5rem)] p-3 sm:p-5 lg:p-6">
      {onLogout && (
        <button
          type="button"
          onClick={() => {
            soundFx.playKeystroke();
            onLogout();
          }}
          title="Disconnect Unit Session"
          className="absolute top-3 right-3 sm:top-5 sm:right-5 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-800/70 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 hover:text-white text-xs font-mono font-bold tracking-wider transition cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>LOGOUT</span>
        </button>
      )}
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/80 to-[#05070c] pointer-events-none" />
      <div className="relative z-10 w-full max-w-4xl mx-auto py-2 sm:py-6">
        <Stepper stage={stage} />
        {stages[stage]()}
      </div>
    </div>
  );
}
