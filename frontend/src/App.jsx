import { useState, useEffect, useCallback, useRef } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import api, { ADMIN_INVALID_EVENT, hasAdminToken } from './services/api.js';
import LandingGlitch from './pages/LandingGlitch.jsx';
import CrtShutdown from './components/CrtShutdown.jsx';
import ChronosIntro from './components/ChronosIntro.jsx';
import Login from './pages/Login.jsx';
import Round1PreLobby from './pages/Round1PreLobby.jsx';
import Round1 from './pages/Round1.jsx';
import Round2Lobby from './pages/Round2Lobby.jsx';
import TransitionRound from './pages/TransitionRound.jsx';
import Round2 from './pages/Round2.jsx';
import Round3 from './pages/Round3.jsx';
import BinaryDissolve from './components/BinaryDissolve.jsx';
import RealityShatter from './components/RealityShatter.jsx';
import SecureModeGuard from './components/SecureModeGuard.jsx';
import Completion from './pages/Completion.jsx';
import AdminLogin from './admin/AdminLogin.jsx';
import Leaderboard from './admin/Leaderboard.jsx';

// View order:
//  'landing'  -> Glitch title page  (START MISSION button)
//  'intro'    -> Full-screen GSAP HTML cinematic intro
//  'login'    -> Team authentication form
//  'prelobby' -> Post-login lobby: START ROUND 1 -> 5 second countdown -> Round 1
//  'round1'   -> Round 1 (timeline classification)
//  'round2lobby' -> Lobby after Round 1: CONTINUE -> Transition Round
//  'transition' -> Physical Transition Round (clue, stopwatch, physical password) -> Round 2
//  'round2'   -> Round 2 (its own page; when it ends it shows the Lobby with START ROUND 3)
//  'round3'   -> Round 3 final accusation (entered only through the Lobby's button)
//  'completion' -> debrief after the Round 3 decision
//  'adminLogin' / 'leaderboard' -> host leaderboard (server-side admin login; /admin and /leaderboard)
//
// A logged-in team (session in localStorage) is routed by its server-side state on reload
// ('resuming'). States are compared with underscores removed because the rounds spell
// them differently (ROUND1_COMPLETED vs ROUND_2_COMPLETED vs ROUND_3_ACTIVE):
// READY -> prelobby, ROUND1ACTIVE -> round1, ROUND1COMPLETED -> round2lobby,
// ROUND2ACTIVE / ROUND2COMPLETED / TIMEOUT -> round2 (its Lobby), ROUND3ACTIVE -> round3,
// COMPLETED -> completion.
// It stays logged in until LOGOUT.

const LOGGED_IN_VIEWS = ['resuming', 'prelobby', 'round1', 'round2lobby', 'transition', 'round2', 'round3', 'completion'];
// Screens a playing team sees (secure mode applies here, never on the host console).
const SECURE_VIEWS = ['prelobby', 'round1', 'round2lobby', 'transition', 'round2', 'round3', 'completion'];
const PRE_ROUND_STATES = ['', 'READY', 'LOGGEDIN', 'REGISTERED'];
const ROUND2_STATES = ['ROUND2ACTIVE', 'ROUND2COMPLETED', 'TIMEOUT'];
const FINISHED_STATES = ['COMPLETED', 'DECISIONSUBMITTED', 'FINALREVEAL'];

const normalizeState = (state) => (state || '').replace(/_/g, '').toUpperCase();

// Where the player last was, per team, so a reload puts them back there (the server state
// decides what is allowed; this only picks between the screens that state allows).
const progressKey = (teamId) => `chronos_progress_${teamId}`;
const REMEMBERED_VIEWS = ['prelobby', 'round1', 'round2lobby', 'transition', 'round2', 'round3', 'completion'];

function readProgress(teamId) {
  try {
    return JSON.parse(localStorage.getItem(progressKey(teamId)) || 'null')?.view || '';
  } catch {
    return '';
  }
}

function writeProgress(teamId, view) {
  try {
    if (view) localStorage.setItem(progressKey(teamId), JSON.stringify({ view, at: Date.now() }));
    else localStorage.removeItem(progressKey(teamId));
  } catch {
    // storage unavailable: resume still works from the server state
  }
}

function AppContent() {
  const { team, logoutTeam } = useAuth();
  const [currentView, setCurrentView] = useState(() => {
    // The host console lives at /admin (and /leaderboard, which is admin-only too).
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/admin' || path === '/leaderboard') {
      return hasAdminToken() ? 'leaderboard' : 'adminLogin';
    }
    return team ? 'resuming' : 'landing';
  });
  const [isCrtActive, setIsCrtActive] = useState(false);
  const [round1Result, setRound1Result] = useState(null);
  // The Round 2 boot sequence plays only on the way in from the Round 2 lobby, never on a reload.
  const [round2Boot, setRound2Boot] = useState(false);
  // True only when Round 3 was just opened with the Lobby's START ROUND 3 button.
  const [round3Intro, setRound3Intro] = useState(false);
  // START ROUND 3 pressed: the Lobby distorts into binary, then Round 3 is revealed
  const [binaryCover, setBinaryCover] = useState(false);
  // CONTINUE pressed in the Round 1 lobby: the reality-shatter plays, then the Physical Transition Round.
  const [shatter, setShatter] = useState(false);
  const shatterRef = useRef(false);
  shatterRef.current = shatter;
  const appRootRef = useRef(null);

  // Remember the screen the team is on (cleared on logout).
  useEffect(() => {
    if (team && REMEMBERED_VIEWS.includes(currentView)) writeProgress(team.team_id, currentView);
  }, [team, currentView]);

  // Tester shortcut: Ctrl+Shift+Alt+K skips the current stage with 0 points (server must run with
  // CHRONOS_ENABLE_SKIP=1, otherwise the request is a 404 and nothing happens).
  const [devNotice, setDevNotice] = useState('');
  const skipBusy = useRef(false);
  const teamIdRef = useRef(null);
  teamIdRef.current = team?.team_id || null;
  useEffect(() => {
    const say = (text, ms = 3500) => {
      setDevNotice(text);
      window.setTimeout(() => setDevNotice(''), ms);
    };
    const skip = async () => {
      const teamId = teamIdRef.current;
      if (!teamId) {
        say('SKIP: LOG IN FIRST');
        return;
      }
      if (skipBusy.current || shatterRef.current) return;
      skipBusy.current = true;
      say('SKIPPING...', 8000);
      try {
        const res = await api.devSkipRound(teamId);
        if (res?.skipped) {
          say(`SKIPPED ${String(res.skipped).toUpperCase()} · 0 POINTS`, 2500);
          setBinaryCover(false);
          setCurrentView('resuming'); // re-read the server state and show the next stage
        } else {
          say('NOTHING LEFT TO SKIP');
        }
      } catch (err) {
        if (err?.status === 404) {
          say('SKIP SHORTCUT IS OFF: the host can switch it on from the admin leaderboard', 6000);
        } else if (err?.status === 401) {
          say('SKIP: SESSION EXPIRED, LOG IN AGAIN', 5000);
        } else {
          say(`SKIP FAILED: ${err?.message || 'server not reachable'}`, 5000);
        }
      } finally {
        skipBusy.current = false;
      }
    };
    const onKey = (e) => {
      const isK = e.code === 'KeyK' || String(e.key).toLowerCase() === 'k';
      if (e.ctrlKey && e.shiftKey && e.altKey && isK) {
        e.preventDefault();
        skip();
      }
    };
    const onMessage = (e) => {
      if (e.origin === window.location.origin && e.data?.type === 'chronos-dev-skip') skip();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('message', onMessage);
    window.chronosSkip = skip; // fallback: type chronosSkip() in the browser console
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('message', onMessage);
      delete window.chronosSkip;
    };
  }, []);

  // Session ended (logout, or server says the team no longer exists) -> back to landing.
  useEffect(() => {
    if (!team && LOGGED_IN_VIEWS.includes(currentView)) {
      setCurrentView('landing');
    }
  }, [team, currentView]);

  // The server rejected the admin token (expired or forged): back to the admin login.
  useEffect(() => {
    const onInvalid = () => {
      setCurrentView((view) => (view === 'leaderboard' ? 'adminLogin' : view));
    };
    window.addEventListener(ADMIN_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(ADMIN_INVALID_EVENT, onInvalid);
  }, []);

  // Put a team on the right screen for its server-side state (login and page reload).
  const routeForState = useCallback(async (teamId, rawState, { fromLogin = false } = {}) => {
    const state = normalizeState(rawState);

    if (state === 'ROUND1ACTIVE') {
      setCurrentView('round1');
      return;
    }
    if (PRE_ROUND_STATES.includes(state)) {
      setCurrentView('prelobby');
      return;
    }
    // Round 2 started (or already finished): its page resumes where the team left off,
    // including the Lobby with the START ROUND 3 button once Round 2 is over.
    if (ROUND2_STATES.includes(state)) {
      setRound2Boot(false);
      setCurrentView('round2');
      return;
    }
    if (state === 'ROUND3ACTIVE') {
      setRound3Intro(false); // reload / login: straight into Round 3
      // A team that went BACK TO LOBBY stays in the Lobby after a reload.
      if (readProgress(teamId) === 'round2') {
        setRound2Boot(false);
        setCurrentView('round2');
      } else {
        setCurrentView('round3');
      }
      return;
    }
    if (FINISHED_STATES.includes(state)) {
      setCurrentView('completion');
      return;
    }
    // Round 1 is finished: the lobby shows its result, unless the team is already inside the
    // transition round (clue shown, stopwatch started, or finished): then it goes back there.
    try {
      const status = await api.getRound1Status(teamId);
      setRound1Result(status.result || null);
    } catch {
      setRound1Result(null);
    }
    // After a fresh login the team lands in the lobby (CONTINUE re-enters the transition round at
    // its saved step); a reload keeps the team inside the round.
    const transition = fromLogin ? null : await api.getTransitionProgress(teamId);
    if (transition && (transition.clue_assigned || transition.started || transition.completed)) {
      setCurrentView('transition');
      return;
    }
    setCurrentView('round2lobby');
  }, []);

  // Reload: ask the server where the team is. If the server cannot be reached, keep asking
  // (the stored state in the browser may be old, so it is never used to pick a screen).
  const [resumeTick, setResumeTick] = useState(0);
  const [resumeWaiting, setResumeWaiting] = useState(false);
  useEffect(() => {
    if (currentView !== 'resuming' || !team) return undefined;
    let cancelled = false;
    let timer = 0;

    (async () => {
      const session = await api.getSession(team.team_id);
      if (cancelled) return;
      if (session?.notFound) return; // AuthContext ends the session; the effect above returns to landing
      if (!session?.current_state) {
        setResumeWaiting(true);
        timer = window.setTimeout(() => setResumeTick((n) => n + 1), 2500);
        return;
      }
      setResumeWaiting(false);
      await routeForState(team.team_id, session.current_state);
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentView, team, routeForState, resumeTick]);

  const handleRound1Complete = useCallback((result) => {
    setRound1Result(result || null);
    setCurrentView('round2lobby');
  }, []);

  const handleStartMission = () => {
    if (isCrtActive) return;
    setIsCrtActive(true);
  };

  const handleCrtComplete = () => {
    setIsCrtActive(false);
    setCurrentView('intro');
  };

  const handleLogout = () => {
    if (team) writeProgress(team.team_id, '');
    logoutTeam();
    setRound1Result(null);
    setCurrentView('landing');
  };

  return (
    <>
    <div
      ref={appRootRef}
      className="min-h-screen bg-[#05070c] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200"
    >
      <main className="flex-1 relative">

        {/* Black CRT chassis backdrop behind the collapsing screen */}
        {isCrtActive && (
          <div className="fixed inset-0 bg-black z-30 pointer-events-none" />
        )}

        {/* Landing page — stays mounted during the intro so it keeps its state */}
        <div
          className={isCrtActive ? 'crt-screen-collapse' : ''}
          style={{
            display:       currentView === 'landing' || currentView === 'intro' ? 'block' : 'none',
            pointerEvents: currentView === 'intro' || isCrtActive ? 'none' : 'auto',
            opacity:       currentView === 'intro' ? 0 : 1,
          }}
        >
          <LandingGlitch
            onStart={handleStartMission}
            onAdminMode={() => setCurrentView(hasAdminToken() ? 'leaderboard' : 'adminLogin')}
            isStarting={isCrtActive}
          />
        </div>

        {/* CRT TV shutdown transition overlay */}
        {isCrtActive && (
          <CrtShutdown onComplete={handleCrtComplete} />
        )}

        {/* GSAP cinematic intro (full-screen, fixed overlay) */}
        {currentView === 'intro' && (
          <ChronosIntro onComplete={() => setCurrentView('login')} />
        )}

        {/* Team authentication */}
        {currentView === 'login' && (
          <Login
            onLoginSuccess={(res) => routeForState(res.team_id, res.current_state, { fromLogin: true })}
            onBackToLanding={() => setCurrentView('landing')}
          />
        )}

        {/* Session sync after a page reload */}
        {currentView === 'resuming' && team && (
          <div className="min-h-[calc(100vh-2.5rem)] flex flex-col gap-3 items-center justify-center font-mono text-sm tracking-widest text-cyan-400">
            <span className="animate-pulse">
              {resumeWaiting ? 'RECONNECTING TO THE SERVER...' : 'SYNCHRONIZING SESSION...'}
            </span>
            {resumeWaiting && (
              <span className="text-[11px] text-slate-500 normal-case tracking-normal">
                Your progress is saved. This page will continue automatically.
              </span>
            )}
          </div>
        )}

        {/* Post-login pre-lobby (5 second countdown, then Round 1) */}
        {currentView === 'prelobby' && team && (
          <Round1PreLobby
            onStartRound1={() => setCurrentView('round1')}
            onLogout={handleLogout}
          />
        )}

        {/* Round 1 — full-screen; the backend owns the clock, scoring and completion */}
        {currentView === 'round1' && team && (
          <Round1 onComplete={handleRound1Complete} />
        )}

        {/* Round 2 — full-screen page; the backend owns the case, clock, AI and scoring */}
        {currentView === 'round2' && team && (
          <Round2
            onLogout={handleLogout}
            boot={round2Boot}
            onRound3Started={() => setBinaryCover(true)}
          />
        )}
        {binaryCover && (
          <BinaryDissolve
            mode="cover"
            duration={1400}
            onComplete={() => {
              setRound3Intro(true);
              setCurrentView('round3');
              setBinaryCover(false);
            }}
          />
        )}

        {/* Round 3 — final accusation; reached only through the Lobby's START ROUND 3 button */}
        {currentView === 'round3' && team && (
          <Round3
            teamId={team.team_id}
            teamName={team.team_name}
            playIntro={round3Intro}
            onNavigateToCompletion={() => setCurrentView('completion')}
            onBackToLobby={() => {
              setRound2Boot(false);
              setCurrentView('round2');
            }}
          />
        )}

        {/* Completion / debrief */}
        {currentView === 'completion' && team && (
          <Completion teamId={team.team_id} onRestart={handleLogout} />
        )}

        {/* Host console: server-side admin login, then the dashboard + leaderboard */}
        {currentView === 'adminLogin' && (
          <AdminLogin onLoginSuccess={() => setCurrentView('leaderboard')} />
        )}
        {currentView === 'leaderboard' && (
          <Leaderboard
            onLogout={() => {
              window.history.replaceState(null, '', '/');
              setCurrentView(team ? 'resuming' : 'landing');
            }}
          />
        )}

        {/* Lobby after Round 1: CONTINUE -> Transition Round */}
        {currentView === 'round2lobby' && team && (
          <Round2Lobby
            result={round1Result}
            onStartRound2={() => {
              if (!shatterRef.current) setShatter(true); // ignored while it is already playing
            }}
            onLogout={handleLogout}
          />
        )}

        {/* Transition Round: clue, stopwatch, physical password; PROCEED -> Round 2 */}
        {currentView === 'transition' && team && (
          <TransitionRound
            teamId={team.team_id}
            teamName={team.team_name}
            onLogout={handleLogout}
            onProceedToRound2={() => {
              setRound2Boot(true);
              setCurrentView('round2');
            }}
          />
        )}

      </main>

      {devNotice && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[200] px-4 py-2 rounded-lg border border-amber-500/70 bg-black/90 font-mono text-xs tracking-widest text-amber-300">
          {devNotice}
        </div>
      )}

      <footer className="border-t border-slate-900 bg-[#04060c] py-2 px-4 text-center font-mono text-[10px] text-slate-600">
        PROJECT CHRONOS // THE GLITCH • TECH FEST EVENT 2140
      </footer>
    </div>
    <SecureModeGuard
      active={Boolean(team) && SECURE_VIEWS.includes(currentView)}
      inGame={Boolean(team) && (SECURE_VIEWS.includes(currentView) || currentView === 'resuming')}
      teamId={team?.team_id}
    />
    {shatter && (
      <RealityShatter
        appRootRef={appRootRef}
        onSwap={() => setCurrentView('transition')}
        onDone={() => setShatter(false)}
      />
    )}
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}
