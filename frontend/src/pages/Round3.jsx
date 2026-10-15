import { useState, useEffect, useRef } from 'react';
import { 
  ShieldAlert, 
  AlertCircle, 
  Cpu, 
  CheckCircle2, 
  FileText, 
  Lock, 
  Sparkles, 
  ChevronRight,
  UserX,
  Radio,
  FileCheck2,
  FolderLock,
  ArrowRight,
  AlertTriangle
} from 'lucide-react';
import { soundFx } from '../utils/audio.js';
import api from '../services/api.js';
import BinaryDissolve from '../components/BinaryDissolve.jsx';
import '../styles/round3.css';

/**
 * Project Chronos — Round 3: Final Decision / Wisdom Round
 * Responsive, high-contrast, cybersecurity terminal layout.
 * Left: Project Alpha, Beta, Gamma candidate selection.
 * Right: Round 2 carried-over evidence references.
 * Points are server-authoritative and kept secret for the awards ceremony.
 */
const MIN_EVIDENCE = 2; // the server enforces the same minimum


export default function Round3({
  teamId,
  teamName = "Temporal Engineers",
  onNavigateToCompletion,
  onBackToLobby,
  playIntro = false
}) {
  // Scenario & Game State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scenarioData, setScenarioData] = useState(null);
  const [round2Inquiries, setRound2Inquiries] = useState(null);
  const [teamInfo, setTeamInfo] = useState(null);

  // User Candidate Selection (Alpha, Beta, or Gamma)
  const [selectedCandidateId, setSelectedCandidateId] = useState(null);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState([]);
  // Right panel: 'evidence' (selectable archive) | 'inquiries' (Round 2 AI questions, review only)
  const [rightTab, setRightTab] = useState('evidence');

  // UI States
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // START ROUND 3 in the Lobby distorts that screen into binary (App.jsx); this screen is then
  // revealed out of the binary (playIntro). A page reload or re-login goes straight to it.
  const [reveal, setReveal] = useState(() => playIntro);
  const revealLayer = reveal ? (
    <BinaryDissolve mode="reveal" duration={900} onComplete={() => setReveal(false)} />
  ) : null;

  // Callbacks change identity on every parent render; keep the loader keyed on teamId only.
  const completionRef = useRef(onNavigateToCompletion);
  const lobbyRef = useRef(onBackToLobby);
  useEffect(() => {
    completionRef.current = onNavigateToCompletion;
    lobbyRef.current = onBackToLobby;
  });

  // Load the team's Round 3 case. This is read-only: Round 3 itself is started only by
  // the Lobby's START ROUND 3 button, never by opening this page.
  useEffect(() => {
    let cancelled = false;

    async function loadRound3() {
      try {
        setLoading(true);
        setError(null);

        const res = await api.getRound3Scenario(teamId);
        if (cancelled) return;

        if (res.is_submitted) {
          completionRef.current?.();
          return;
        }

        setScenarioData(res.scenario);
        setRound2Inquiries(res.round2_investigation || null);
        setTeamInfo({ id: res.team_id, name: res.team_name || teamName });
      } catch (err) {
        if (cancelled) return;
        if (err.status === 409) {
          // Round 3 has not been started with the Lobby button: send the team back there.
          lobbyRef.current?.();
          return;
        }
        console.error("Failed to initialize Round 3:", err);
        setError(err.message || "Failed to establish secure connection to Round 3 Mainframe.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (teamId) {
      loadRound3();
    }
    return () => { cancelled = true; };
  }, [teamId, teamName]);

  // Handle Candidate Selection
  const handleSelectCandidate = (candidateId) => {
    soundFx.playKeystroke();
    setSelectedCandidateId(candidateId);
  };

  // Toggle Evidence Selection
  const handleToggleEvidence = (evId) => {
    soundFx.playKeystroke();
    setSelectedEvidenceIds((prev) => {
      if (prev.includes(evId)) {
        return prev.filter((id) => id !== evId);
      } else {
        return [...prev, evId];
      }
    });
  };

  // Open Confirmation Modal
  const handleInitiateSubmission = () => {
    if (!selectedCandidateId || selectedEvidenceIds.length < MIN_EVIDENCE) {
      soundFx.playError();
      return;
    }
    soundFx.playWhoosh();
    setIsConfirmModalOpen(true);
  };

  // Final Submit: errors are shown, never swallowed, and the team only moves on once the
  // server has accepted (or already holds) the decision.
  const handleFinalSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      await api.submitRound3Decision(teamId, selectedCandidateId, selectedEvidenceIds);
      soundFx.playAccessGranted();
      setIsConfirmModalOpen(false);
      completionRef.current?.();
    } catch (err) {
      console.error("Submission failed:", err);
      soundFx.playError();
      setSubmitError(err.message || "Could not record decision. Please try again.");
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-2.5rem)] flex flex-col items-center justify-center p-6 text-center">
        {revealLayer}
        <div className="w-14 h-14 rounded-full border-4 border-cyan-500 border-t-transparent animate-spin mb-4" />
        <p className="font-mono text-cyan-300 tracking-widest text-sm animate-pulse">
          INITIALIZING ROUND 3: FINAL DECISION MAINFRAME...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[calc(100vh-2.5rem)] flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md p-6 rounded-2xl bg-rose-950/80 border border-rose-700 text-rose-200 space-y-4">
          <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
          <h2 className="text-xl font-bold font-tech">TIMELINE LINK FAILURE</h2>
          <p className="font-mono text-xs text-rose-300 leading-relaxed">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-600 text-white font-mono font-bold text-xs uppercase cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const candidates = scenarioData?.candidates || [];
  const evidenceList = scenarioData?.evidence_archive || [];
  const inquiries = round2Inquiries?.chat_messages || [];
  const activeCandidate = candidates.find((c) => c.id === selectedCandidateId);
  const canSubmit = Boolean(selectedCandidateId) && selectedEvidenceIds.length >= MIN_EVIDENCE;

  return (
    <div className="r3 r3-in relative min-h-[calc(100vh-2.5rem)] flex flex-col items-center justify-center p-3 sm:p-5 lg:p-6">
      {revealLayer}
      <div className="r3-bg" />
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/85 to-[#05070c] pointer-events-none" />

      <div className="relative w-full max-w-6xl z-10 space-y-4 my-auto">
        {/* Top Header Card */}
        <div className="r3-head r3-hud bg-[#070c18]/95 border border-cyan-800/60 rounded-2xl p-4 sm:p-5 shadow-[0_0_35px_rgba(6,182,212,0.15)] backdrop-blur-xl flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-950/80 border border-cyan-700/80 text-cyan-300">
              <ShieldAlert className="w-6 h-6 text-pink-400 animate-pulse" />
            </div>
            <div>
              <div className="r3-eyebrow">
                <span className="r3-phase"><b>03</b>Phase</span>
                <span>Time-lock critical</span>
              </div>
              <h1 className="r3-title">
                <span className="r3-title-main">Final accusation</span>
                <span className="r3-title-sub">Identify the corrupted core</span>
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap justify-center">
            <button
              type="button"
              onClick={() => lobbyRef.current?.()}
              disabled={isSubmitting}
              title="Return to the Lobby (your Round 3 progress is kept)"
              className="px-3 py-1.5 rounded-lg border border-slate-600/80 bg-slate-900/60 hover:bg-slate-800/80 hover:border-cyan-500 text-slate-300 hover:text-white text-xs font-mono font-bold tracking-wider inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span aria-hidden="true">◂</span>
              <span>BACK TO LOBBY</span>
            </button>
          </div>
        </div>

        {/* Main Grid: Suspects on Left, Evidence Archives on Right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          
          {/* LEFT 7 COLUMNS: Suspect Candidates (Alpha, Beta, Gamma) */}
          <div className="lg:col-span-7 space-y-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-mono uppercase tracking-widest text-slate-400 font-bold flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                SELECT CORRUPTED CORE CANDIDATE (CHOOSE 1)
              </span>
              <span className="text-[0.8125rem] font-mono text-pink-400">
                {selectedCandidateId ? '1 CANDIDATE SELECTED' : 'SELECTION REQUIRED'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {candidates.map((cand, idx) => {
                const isSelected = selectedCandidateId === cand.id;
                return (
                  <div
                    key={cand.id}
                    role="radio"
                    aria-checked={isSelected}
                    tabIndex={0}
                    style={{ '--i': idx + 1 }}
                    onClick={() => handleSelectCandidate(cand.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectCandidate(cand.id);
                      }
                    }}
                    className={`r3-card r3-cand ${isSelected ? 'is-sel' : ''} p-4 sm:p-5 rounded-2xl border transition-all cursor-pointer relative overflow-hidden ${
                      isSelected
                        ? 'bg-[#0b1528] border-pink-500 shadow-[0_0_25px_rgba(244,63,94,0.3)]'
                        : 'bg-[#070c18]/90 border-cyan-900/50 hover:border-cyan-700/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center font-mono font-bold text-sm ${
                            isSelected
                              ? 'bg-pink-500 text-white shadow-[0_0_15px_rgba(244,63,94,0.6)]'
                              : 'bg-cyan-950 border border-cyan-800 text-cyan-400'
                          }`}
                        >
                          {cand.id.toUpperCase().slice(0, 1)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-tech text-lg sm:text-xl font-bold text-white tracking-wide">
                              {cand.name}
                            </h3>
                            <span className="text-[0.75rem] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-800 text-cyan-300 uppercase">
                              {cand.timeline_sector}
                            </span>
                          </div>
                          <p className="text-xs font-mono text-slate-400 mt-0.5">
                            Lead: <span className="text-slate-200">{cand.lead_name}</span> • Clearance: {cand.clearance_level}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center">
                        <div
                          className={`w-6 h-6 rounded-full border flex items-center justify-center transition-all ${
                            isSelected
                              ? 'border-pink-500 bg-pink-500 text-white'
                              : 'border-slate-600 bg-transparent'
                          }`}
                        >
                          {isSelected && <CheckCircle2 className="w-4 h-4" />}
                        </div>
                      </div>
                    </div>

                    {/* Dossier & Forensic Discrepancy */}
                    <div className="mt-3 text-xs font-mono text-slate-300 bg-black/50 p-3 rounded-xl border border-cyan-950 space-y-1.5">
                      <p className="leading-relaxed">{cand.dossier}</p>
                      <div className="r3-disc text-[0.8125rem] text-pink-300/90 pt-1 mt-1 border-t border-cyan-950 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-pink-400 shrink-0 mt-0.5" />
                        <span><strong>Forensic Discrepancy:</strong> {cand.discrepancy}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT 5 COLUMNS: Carried Evidence Logs & Submit Button */}
          <div className="lg:col-span-5 space-y-3 flex flex-col justify-between">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 mb-3">
                <div className="flex items-center gap-1.5" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={rightTab === 'evidence'}
                    onClick={() => setRightTab('evidence')}
                    className={`px-2.5 py-1.5 rounded-lg border text-[0.8125rem] font-mono font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer transition ${
                      rightTab === 'evidence'
                        ? 'border-cyan-500 bg-cyan-950/60 text-cyan-200'
                        : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileCheck2 className="w-3.5 h-3.5" />
                    EVIDENCE ({evidenceList.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={rightTab === 'inquiries'}
                    onClick={() => setRightTab('inquiries')}
                    className={`px-2.5 py-1.5 rounded-lg border text-[0.8125rem] font-mono font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer transition ${
                      rightTab === 'inquiries'
                        ? 'border-pink-500 bg-pink-950/40 text-pink-200'
                        : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" />
                    AI INQUIRIES ({inquiries.length})
                  </button>
                </div>
                {rightTab === 'evidence' && (
                  <span className={`r3-count ${selectedEvidenceIds.length >= MIN_EVIDENCE ? 'ok' : ''}`}>
                    <b>{selectedEvidenceIds.length}</b> SELECTED · MIN {MIN_EVIDENCE}
                  </span>
                )}
              </div>

              {rightTab === 'inquiries' && (
                <div className="space-y-2.5" role="tabpanel">
                  <p className="px-1 flex items-center justify-between gap-2 text-[0.75rem] font-mono uppercase tracking-widest text-slate-500">
                    <span>Round 2 analyst questions</span>
                    <span className="r3-tag">Review only</span>
                  </p>
                  {inquiries.length === 0 ? (
                    <div className="p-4 rounded-xl border border-slate-800 bg-[#070c18]/80 text-[0.8125rem] font-mono text-slate-400">
                      No AI questions were asked in Round 2.
                    </div>
                  ) : (
                    inquiries.map((m) => (
                      <div
                        key={m.question_number}
                        className="r3-card p-3.5 rounded-xl border border-cyan-900/40 bg-[#070c18]/80 space-y-2"
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-[0.75rem] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-800 text-cyan-300 shrink-0">
                            Q{m.question_number}
                          </span>
                          <p className="text-[0.875rem] font-mono text-slate-200 leading-relaxed whitespace-pre-wrap">
                            {m.user_prompt}
                          </p>
                        </div>
                        <div className="flex items-start gap-2 pl-0.5">
                          <span className="text-[0.75rem] font-mono font-bold px-1.5 py-0.5 rounded bg-pink-950/60 border border-pink-900 text-pink-300 shrink-0">
                            AI
                          </span>
                          <p className="text-[0.8125rem] font-mono text-slate-400 leading-relaxed whitespace-pre-wrap">
                            {m.ai_response}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              <div className={`space-y-2.5 ${rightTab === 'evidence' ? '' : 'hidden'}`}>
                {evidenceList.map((ev, idx) => {
                  const isChecked = selectedEvidenceIds.includes(ev.id);
                  return (
                    <div
                      key={ev.id}
                      role="checkbox"
                      aria-checked={isChecked}
                      tabIndex={0}
                      style={{ '--i': idx + 4 }}
                      onClick={() => handleToggleEvidence(ev.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggleEvidence(ev.id);
                        }
                      }}
                      className={`r3-card r3-ev ${isChecked ? 'is-on' : ''} p-3.5 rounded-xl border transition cursor-pointer flex items-start justify-between gap-2.5 ${
                        isChecked
                          ? 'bg-[#091523] border-emerald-500/80 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                          : 'bg-[#070c18]/80 border-cyan-900/40 hover:border-cyan-800'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <FileText className={`w-4 h-4 mt-0.5 shrink-0 ${isChecked ? 'text-emerald-400' : 'text-slate-500'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-xs text-cyan-300">
                              {ev.label}
                            </span>
                            <span className="text-[0.75rem] font-mono px-1.5 py-0.2 rounded bg-black/60 border border-cyan-900 text-slate-400 uppercase">
                              {ev.source_file}
                            </span>
                          </div>
                          <p className="text-[0.875rem] font-mono text-slate-300 mt-1 leading-relaxed whitespace-pre-line">
                            {ev.description}{ev.timestamp ? `\n• Time: ${ev.timestamp}` : ''}
                          </p>
                        </div>
                      </div>

                      <div
                        className={`w-4 h-4 rounded mt-1 border flex items-center justify-center shrink-0 transition ${
                          isChecked ? 'border-emerald-400 bg-emerald-500 text-slate-950' : 'border-slate-600'
                        }`}
                      >
                        {isChecked && <CheckCircle2 className="w-3.5 h-3.5" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Submission CTA Block */}
            <div className="pt-3">
              <button
                disabled={!canSubmit || isSubmitting}
                onClick={handleInitiateSubmission}
                className={`r3-cta ${canSubmit && !isSubmitting ? 'ready' : ''} w-full py-4 px-6 rounded-xl font-tech font-bold text-base tracking-widest uppercase transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer ${
                  canSubmit && !isSubmitting
                    ? 'text-slate-950 bg-gradient-to-r from-pink-500 via-rose-400 to-cyan-300 hover:from-pink-400 hover:to-cyan-200 shadow-[0_0_30px_rgba(244,63,94,0.5)] hover:shadow-[0_0_45px_rgba(244,63,94,0.8)]'
                    : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed opacity-60'
                }`}
              >
                <span>LOCK IN FINAL ACCUSATION</span>
                <ArrowRight className="w-5 h-5 text-current" />
              </button>
              {selectedCandidateId && selectedEvidenceIds.length < MIN_EVIDENCE && (
                <p className="text-[0.8125rem] font-mono text-amber-400 text-center mt-2">
                  Select at least {MIN_EVIDENCE} supporting evidence items to lock in your accusation.
                </p>
              )}
              <p className="text-[0.8125rem] font-mono text-slate-500 text-center mt-2">
                All decisions are permanent and recorded in the temporal ledger.
              </p>
            </div>
          </div>

        </div>

        {/* Modal: Confirmation & Lock-In */}
        {isConfirmModalOpen && (
          <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-[#070c18] border border-pink-700 rounded-2xl p-6 space-y-5 shadow-[0_0_60px_rgba(244,63,94,0.4)] text-center">
              <ShieldAlert className="w-12 h-12 text-pink-400 mx-auto animate-bounce" />
              <div className="space-y-1">
                <h3 className="text-2xl font-bold font-tech text-white">CONFIRM FINAL ACCUSATION</h3>
                <p className="text-xs font-mono text-pink-300">
                  YOU ARE ACCUSING <span className="text-white font-bold">{activeCandidate?.name.toUpperCase()}</span>
                </p>
              </div>

              <div className="p-4 bg-black/60 rounded-xl border border-pink-900/60 text-left text-xs font-mono text-slate-300 space-y-1.5">
                <div>• Selected Candidate: <strong className="text-pink-400">{activeCandidate?.name}</strong></div>
                <div>• Lead: {activeCandidate?.lead_name} ({activeCandidate?.timeline_sector})</div>
                <div>• Verified Supporting Evidence: {selectedEvidenceIds.length} items</div>
              </div>

              {submitError && (
                <div className="p-3 rounded-xl bg-rose-950/80 border border-rose-700 text-rose-200 text-xs font-mono text-left">
                  {submitError}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  disabled={isSubmitting}
                  onClick={() => { setSubmitError(''); setIsConfirmModalOpen(false); }}
                  className="flex-1 py-3 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono font-bold text-xs uppercase cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  disabled={isSubmitting}
                  onClick={handleFinalSubmit}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 text-white font-mono font-bold text-xs uppercase shadow-[0_0_20px_rgba(244,63,94,0.6)] cursor-pointer"
                >
                  {isSubmitting ? 'RECORDING...' : 'YES, TRANSMIT'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
