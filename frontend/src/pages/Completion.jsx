import { useState, useEffect } from 'react';
import { Trophy, RotateCcw, ShieldCheck, FileCheck2 } from 'lucide-react';
import api from '../services/api.js';
import { soundFx } from '../utils/audio.js';
import ThemeSelector from '../components/ThemeSelector';
import ChronosConclusion from '../components/ChronosConclusion.jsx';

/**
 * Project Chronos — Final Mission Debrief & Completion Screen
 * High-readability cyberpunk layout.
 * Final scores and rankings are never shown here; the host reveals them at the closing awards.
 */
export default function Completion({ 
  teamId, 
  onRestart 
}) {
  const [loading, setLoading] = useState(true);
  const [verdictData, setVerdictData] = useState(null);
  // The Timeline Convergence cinematic plays first (skippable), then the debrief appears.
  const seenKey = `chronos_conclusion_seen_${teamId}`;
  const [showCinematic, setShowCinematic] = useState(() => {
    try {
      return !localStorage.getItem(seenKey);
    } catch {
      return true;
    }
  });

  useEffect(() => {
    async function loadVerdict() {
      try {
        setLoading(true);
        if (teamId) {
          const res = await api.getRound3Verdict(teamId);
          if (res.status === 'success') {
            setVerdictData(res);
          }
        }
      } catch (err) {
        console.error("Failed to load completion verdict:", err);
      } finally {
        setLoading(false);
      }
    }
    loadVerdict();
  }, [teamId]);

  if (showCinematic) {
    return (
      <ChronosConclusion
        onComplete={() => {
          try {
            localStorage.setItem(seenKey, '1');
          } catch {
            // storage unavailable: the cinematic may play again on reload
          }
          setShowCinematic(false);
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-2.5rem)] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-14 h-14 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin mb-4" />
        <p className="font-mono text-emerald-300 tracking-widest text-sm animate-pulse">
          SYNCHRONIZING TIMELINE AUDIT LEDGER...
        </p>
      </div>
    );
  }

  const teamName = verdictData?.team_name || "Temporal Engineers";
  const submission = verdictData?.submission || {};
  const verdictDetails = verdictData?.verdict_details || {};

  return (
    <div className="relative min-h-[calc(100vh-2.5rem)] bg-[var(--bg-primary)] text-[var(--text-body)] flex flex-col items-center justify-center p-3 sm:p-5 lg:p-6 overflow-x-hidden font-space">
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/85 to-[#05070c] pointer-events-none" />

      {/* Atmospheric Glow */}
      <div 
        className="fixed top-1/4 left-1/4 w-[600px] h-[600px] rounded-full blur-[180px] pointer-events-none opacity-20"
        style={{ backgroundColor: 'var(--neon-primary)' }}
      ></div>

      {/* Top Right Header Theme Selector */}
      <div className="fixed top-6 right-6 z-50">
        <ThemeSelector />
      </div>

      <div className="relative w-full max-w-4xl z-10 space-y-5 my-auto text-center">
        
        {/* Main Completion Card */}
        <div className="bg-[#070c18]/95 border border-emerald-800/60 rounded-3xl p-6 sm:p-8 shadow-[0_0_50px_rgba(16,185,129,0.2)] backdrop-blur-xl space-y-6">
          
          <h1 className="font-orbitron font-black text-4xl lg:text-6xl text-white tracking-wider">
            THANK YOU FOR <span style={{ color: 'var(--neon-primary)' }}>PLAYING</span>
          </h1>
          <p className="text-xs sm:text-sm font-mono text-slate-400 pt-1">
            Unit: <strong className="text-cyan-300">{teamName}</strong> • Event: TECH FEST 2140
          </p>

          {/* Submission Summary Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
            <div className="p-4 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 space-y-2">
              <div className="flex items-center gap-2 text-cyan-400 font-mono text-xs uppercase font-bold tracking-wider">
                <FileCheck2 className="w-4 h-4" />
                <span>ACCUSED SUSPECT</span>
              </div>
              <div className="text-lg font-bold font-mono text-white">
                {submission.selected_candidate_name || submission.selected_candidate_id || "RECORDED"}
              </div>
              <div className="text-[0.8125rem] font-mono text-slate-400">
                Submitted at: {submission.submitted_at ? new Date(submission.submitted_at).toLocaleTimeString() : "CONFIRMED"}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#03060f]/90 border border-emerald-900/60 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-mono text-xs uppercase font-bold tracking-wider">
                <ShieldCheck className="w-4 h-4" />
                <span>TIMELINE CONTINUUM</span>
              </div>
              <div className="text-lg font-bold font-mono text-emerald-300">
                STABILIZATION ENGAGED
              </div>
              <div className="text-[0.8125rem] font-mono text-slate-400">
                All rounds concluded. Awaiting leaderboard reveal.
              </div>
            </div>
          </div>

          {/* Forensic Debrief Dossier */}
          {verdictDetails.narrative_summary && (
            <div className="p-5 rounded-2xl bg-black/60 border border-cyan-950 text-left space-y-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-400 block">
                FORENSIC NARRATIVE RESOLUTION (GAME CONCLUSION):
              </span>
              <p className="text-xs sm:text-sm font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">
                {verdictDetails.narrative_summary}
              </p>
            </div>
          )}

          {/* CTA Actions */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => {
                soundFx.playAccessGranted();
                if (onRestart) onRestart();
              }}
              className="w-full py-4 rounded-xl bg-white/5 border border-white/15 hover:border-[var(--neon-primary)] font-orbitron font-bold text-sm text-[var(--text-muted)] hover:text-white transition-all flex items-center justify-center gap-2 cursor-pointer hover:shadow-lg"
            >
              <RotateCcw className="w-4 h-4" />
              <span>RETURN TO MAIN TERMINAL</span>
            </button>
          </div>

        </div>

      </div>
    </div>
  );
}
