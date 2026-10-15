import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { soundFx } from '../utils/audio.js';
import {
  Play,
  Cpu,
  Users,
  IdCard,
  LogOut
} from 'lucide-react';

/**
 * Post-login holding screen.
 * Round 1 itself (GET /api/round1/items ...) is owned by the Round 1 page; this screen only
 * confirms the team identity, plays the HUD interlude and then hands over via
 * `onStartRound1`. The team's Round 1 clock does not start until the Round 1 page loads.
 */
const HUD_SECONDS = 8; // one full loop of the HUD animation, then Round 1 opens

export default function Round1PreLobby({ onStartRound1, onLogout }) {
  const { team, logoutTeam } = useAuth();
  const [showHud, setShowHud] = useState(false);
  const handedOverRef = useRef(false);

  const handleLogout = () => {
    soundFx.playKeystroke();
    logoutTeam();
    if (onLogout) onLogout();
  };

  const handleStartRound1 = () => {
    if (showHud) return;
    soundFx.playAccessGranted();
    setShowHud(true);
  };

  useEffect(() => {
    if (!showHud) return undefined;
    const handOver = () => {
      if (handedOverRef.current) return;
      handedOverRef.current = true;
      if (onStartRound1) onStartRound1(team);
    };
    // The HUD posts this the moment its animation ends, so Round 1 opens right away.
    const onMsg = (e) => {
      if (e.data && e.data.type === 'chronos-hud-done') handOver();
    };
    window.addEventListener('message', onMsg);
    // Fallback in case the message never arrives (audio init delays the HUD clock).
    const timer = setTimeout(handOver, (HUD_SECONDS + 6) * 1000);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHud]);


  return (
    <div className="relative min-h-[calc(100vh-2.5rem)] flex items-center justify-center p-3 sm:p-5 lg:p-6">
      {showHud && (
        <div className="fixed inset-0 z-50 bg-black">
          <iframe
            title="Timeline clash diagnostic"
            src="/transition-hud.html"
            className="block w-full h-full border-0 bg-black"
            allow="autoplay"
          />
        </div>
      )}
      {/* Ambience Grid */}
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/80 to-[#05070c] pointer-events-none" />

      <div className="relative w-full max-w-3xl z-10 text-center space-y-5 my-auto">
        
        {/* Main Team Identity Card */}
        <div className="bg-[#070c18]/95 border border-cyan-800/60 rounded-2xl p-5 sm:p-8 shadow-[0_0_50px_rgba(6,182,212,0.15)] backdrop-blur-xl relative overflow-hidden">
          {/* Top Accent Strip with Landing Page Cyan-to-Pink gradient */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-400 via-pink-500 to-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.7)]" />

          {/* Callsign & Team Badge Header */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-b border-cyan-900/50 pb-4 mb-5">
            <div className="text-left">
              <span className="text-xs font-mono uppercase tracking-[0.25em] text-slate-400">
                CONNECTED CALLSIGN
              </span>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold font-tech text-cyan-300 tracking-wide mt-0.5">
                {team?.team_name}
              </h2>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="px-3.5 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-700/80 text-cyan-300 text-xs sm:text-sm font-mono font-bold tracking-wider inline-flex items-center gap-1.5 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
                <Users className="w-4 h-4 text-cyan-400" />
                <span>TEAM ID: #{team?.team_id ?? '-'}</span>
              </span>
              <button
                onClick={handleLogout}
                className="px-3 py-1.5 rounded-lg border border-rose-900/70 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 hover:text-rose-100 text-xs sm:text-sm font-mono font-bold tracking-wider inline-flex items-center gap-1.5 transition cursor-pointer"
                title="Disconnect Unit Session"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>LOGOUT</span>
              </button>
            </div>
          </div>

          {/* Members & PRNs Display */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 sm:gap-4 text-left">
            <div className="p-3.5 sm:p-4 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono text-cyan-400 uppercase tracking-wider font-bold pb-1 border-b border-cyan-950">
                <span className="flex items-center gap-1.5">
                  <IdCard className="w-3.5 h-3.5" />
                  <span>Operator 1</span>
                </span>
                <span className="text-[0.8125rem] text-slate-500">PRIMARY</span>
              </div>
              <span className="text-white font-bold font-mono text-base sm:text-lg block pt-0.5">
                {team?.member_1_name || 'Member 1'}
              </span>
              <span className="text-cyan-400/90 font-mono text-xs sm:text-sm block">
                PRN: {team?.member_1_prn || 'N/A'}
              </span>
            </div>

            <div className="p-3.5 sm:p-4 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono text-cyan-400 uppercase tracking-wider font-bold pb-1 border-b border-cyan-950">
                <span className="flex items-center gap-1.5">
                  <IdCard className="w-3.5 h-3.5" />
                  <span>Operator 2</span>
                </span>
                <span className="text-[0.8125rem] text-slate-500">CO-PILOT</span>
              </div>
              <span className="text-white font-bold font-mono text-base sm:text-lg block pt-0.5">
                {team?.member_2_name || 'Member 2'}
              </span>
              <span className="text-cyan-400/90 font-mono text-xs sm:text-sm block">
                PRN: {team?.member_2_prn || 'N/A'}
              </span>
            </div>
          </div>

          {/* Mission Briefing Box */}
          <div className="mt-5 p-4 sm:p-5 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 text-left space-y-2">
            <div className="flex items-center gap-2 text-cyan-300 font-bold uppercase tracking-wider text-xs sm:text-sm">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>Round 1 Briefing: Temporal Deconfliction</span>
            </div>
            <p className="text-slate-300 font-mono leading-relaxed text-xs sm:text-sm">
              You have <span className="text-cyan-300 font-semibold">5 minutes</span> for this round. The clock starts the moment you begin. Locate anomalous timeline coordinates, eliminate historical contradictions, and submit fragments.
            </p>
          </div>

          {/* Primary CTA Button */}
          <div className="mt-6 sm:mt-7">
              <button
                onClick={handleStartRound1}
                className="group relative inline-flex items-center justify-center w-full py-3.5 sm:py-4 px-8 text-base sm:text-lg font-bold font-tech tracking-widest uppercase transition-all duration-300 rounded-xl text-slate-950 bg-gradient-to-r from-emerald-400 via-cyan-300 to-emerald-400 hover:from-emerald-300 hover:to-cyan-200 shadow-[0_0_30px_rgba(16,185,129,0.5)] hover:shadow-[0_0_45px_rgba(16,185,129,0.8)] hover:scale-[1.02] active:scale-95 border border-emerald-200 cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <Play className="w-5 h-5 text-slate-950 fill-current animate-pulse" />
                  <span>CLICK TO START ROUND 1</span>
                </div>
              </button>
          </div>

        </div>

        {/* Security Notice with target text removed */}
        <div className="text-xs font-mono text-slate-500">
          Terminal Status: Standard Player Mode
        </div>

      </div>
    </div>
  );
}
