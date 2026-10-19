import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../services/api.js';
import { enterSecureMode } from '../utils/secureMode.js';
import { soundFx } from '../utils/audio.js';
import {
  AlertTriangle,
  ShieldCheck,
  IdCard,
  ArrowLeft,
  Cpu
} from 'lucide-react';

const PRN_PATTERN = /^(23|24|25|26)\d{9}$/;

export default function Login({ onLoginSuccess, onBackToLanding }) {
  const secureModeOn = useRef(true);
  useEffect(() => {
    api.getSecurityConfig().then((on) => {
      secureModeOn.current = on;
    });
  }, []);
  const { loginTeamSession } = useAuth();
  const [formData, setFormData] = useState({
    team_name: '',
    member1_name: '',
    member2_name: '',
    member1_prn: '',
    member2_prn: '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleInputChange = (field, value) => {
    soundFx.playKeystroke();
    // PRN fields take digits only (at most 11).
    if (field === 'member1_prn' || field === 'member2_prn') value = value.replace(/\D/g, '').slice(0, 11);
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errorMsg) setErrorMsg('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Validation
    if (!formData.team_name.trim()) {
      soundFx.playGlitch();
      setErrorMsg('Team Name designation is required.');
      return;
    }
    if (!formData.member1_name.trim() || !formData.member2_name.trim()) {
      soundFx.playGlitch();
      setErrorMsg('Both Member 1 and Member 2 names are required.');
      return;
    }
    if (!formData.member1_prn.trim() || !formData.member2_prn.trim()) {
      soundFx.playGlitch();
      setErrorMsg('PRN credentials for both Member 1 and Member 2 are required.');
      return;
    }
    // A PRN is exactly 11 digits and starts with 23, 24, 25 or 26.
    if (!PRN_PATTERN.test(formData.member1_prn.trim()) || !PRN_PATTERN.test(formData.member2_prn.trim())) {
      soundFx.playGlitch();
      setErrorMsg('Each PRN must be exactly 11 digits and start with 23, 24, 25 or 26.');
      return;
    }

    // Secure mode: fullscreen + keyboard lock, asked for straight from this click (a browser only
    // allows it while the click is fresh). The host can switch it off with CHRONOS_SECURE_MODE=0;
    // if the browser refuses, an overlay asks again after login.
    if (secureModeOn.current) enterSecureMode();

    try {
      setIsSubmitting(true);
      setErrorMsg('');

      const res = await api.login({
        team_name: formData.team_name.trim(),
        member_1_name: formData.member1_name.trim(),
        member_2_name: formData.member2_name.trim(),
        member_1_prn: formData.member1_prn.trim(),
        member_2_prn: formData.member2_prn.trim(),
      });

      soundFx.playAccessGranted();
      loginTeamSession(res);

      setTimeout(() => {
        if (onLoginSuccess) onLoginSuccess(res);
      }, 500);
    } catch (err) {
      soundFx.playGlitch();
      setErrorMsg(err.message || 'Authentication error. Contact event host.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh-2.5rem)] flex items-center justify-center p-3 sm:p-5 lg:p-6">
      {/* Background Ambience */}
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/80 to-[#05070c] pointer-events-none" />

      <div className="relative w-full max-w-3xl z-10 my-auto">
        
        {/* Top Navigation Row */}
        <div className="flex items-center justify-between mb-3 px-1">
          <button
            onClick={onBackToLanding}
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-mono tracking-wider text-cyan-400 hover:text-cyan-200 transition py-1 px-2.5 rounded bg-cyan-950/40 border border-cyan-900/60 hover:border-cyan-500/60"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>RETURN TO INTRO</span>
          </button>
          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-cyan-500/80">
            <Cpu className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>NODE::AUTH-GATE 01</span>
          </div>
        </div>

        {/* Main Authentication Card */}
        <div className="bg-[#070c18]/95 border border-cyan-800/60 rounded-2xl p-5 sm:p-8 shadow-[0_0_50px_rgba(6,182,212,0.15)] backdrop-blur-xl relative overflow-hidden">
          {/* Top Accent Strip with Landing Page Cyan-to-Pink gradient */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-400 via-pink-500 to-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.7)]" />

          {/* Header */}
          <div className="flex items-start justify-between border-b border-cyan-900/50 pb-4 mb-5">
            <div>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold font-tech text-white tracking-wide">
                Team Authentication
              </h2>
            </div>
            <div className="hidden sm:block text-right">
              <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-cyan-950/80 border border-cyan-800 text-cyan-300 uppercase tracking-widest">
                VERIFICATION REQUIRED
              </span>
            </div>
          </div>

          {/* Error Message */}
          {errorMsg && (
            <div className="mb-4 p-3 rounded-lg bg-rose-950/90 border border-rose-500 text-rose-200 text-sm font-mono flex items-center gap-3 animate-shake">
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Registration Form */}
          <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
            
            {/* Field 1: Team Name */}
            <div className="bg-[#03060f]/90 p-3.5 sm:p-4 rounded-xl border border-cyan-900/60 focus-within:border-cyan-400/80 transition">
              <label className="block text-xs sm:text-sm font-mono font-bold text-cyan-300 mb-1.5 uppercase tracking-wider">
                1. Team Name (Unique Callsign)
              </label>
              <input
                type="text"
                value={formData.team_name}
                onChange={(e) => handleInputChange('team_name', e.target.value)}
                placeholder="e.g. Quantum Paradox"
                maxLength={50}
                className="w-full bg-[#050814] border border-cyan-950 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/50 rounded-lg px-3.5 sm:px-4 py-2.5 sm:py-3 text-sm sm:text-base font-mono text-white placeholder-slate-500 outline-none transition"
                disabled={isSubmitting}
                autoFocus
              />
            </div>

            {/* Operators Dual Section Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 sm:gap-4">
              
              {/* Operator 1 Section */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 space-y-3 focus-within:border-cyan-500/70 transition">
                <div className="text-xs sm:text-sm font-mono font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-2 pb-1 border-b border-cyan-950">
                  <IdCard className="w-4 h-4 text-cyan-400" />
                  <span>Operator 1 Specifications</span>
                </div>
                
                {/* Field 2: Member 1 Name */}
                <div>
                  <label className="block text-xs sm:text-sm font-mono text-slate-300 mb-1">
                    2. Member 1 Full Name
                  </label>
                  <input
                    type="text"
                    value={formData.member1_name}
                    onChange={(e) => handleInputChange('member1_name', e.target.value)}
                    placeholder="e.g. Alex Vance"
                    maxLength={50}
                    className="w-full bg-[#050814] border border-slate-800 focus:border-cyan-400 rounded-lg px-3 py-2 sm:py-2.5 text-sm sm:text-base font-mono text-white placeholder-slate-500 outline-none transition"
                    disabled={isSubmitting}
                  />
                </div>

                {/* Field: Member 1 PRN */}
                <div>
                  <label className="block text-xs sm:text-sm font-mono text-slate-300 mb-1">
                    Member 1 PRN
                  </label>
                  <input
                    type="text"
                    value={formData.member1_prn}
                    onChange={(e) => handleInputChange('member1_prn', e.target.value)}
                    placeholder="e.g. 24070123456"
                    inputMode="numeric"
                    maxLength={11}
                    className="w-full bg-[#050814] border border-slate-800 focus:border-cyan-400 rounded-lg px-3 py-2 sm:py-2.5 text-sm sm:text-base font-mono text-white placeholder-slate-500 outline-none transition"
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              {/* Operator 2 Section */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-[#03060f]/90 border border-cyan-900/60 space-y-3 focus-within:border-cyan-500/70 transition">
                <div className="text-xs sm:text-sm font-mono font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-2 pb-1 border-b border-cyan-950">
                  <IdCard className="w-4 h-4 text-cyan-400" />
                  <span>Operator 2 Specifications</span>
                </div>
                
                {/* Field 3: Member 2 Name */}
                <div>
                  <label className="block text-xs sm:text-sm font-mono text-slate-300 mb-1">
                    3. Member 2 Full Name
                  </label>
                  <input
                    type="text"
                    value={formData.member2_name}
                    onChange={(e) => handleInputChange('member2_name', e.target.value)}
                    placeholder="e.g. Gordon Freeman"
                    maxLength={50}
                    className="w-full bg-[#050814] border border-slate-800 focus:border-cyan-400 rounded-lg px-3 py-2 sm:py-2.5 text-sm sm:text-base font-mono text-white placeholder-slate-500 outline-none transition"
                    disabled={isSubmitting}
                  />
                </div>

                {/* Field: Member 2 PRN */}
                <div>
                  <label className="block text-xs sm:text-sm font-mono text-slate-300 mb-1">
                    Member 2 PRN
                  </label>
                  <input
                    type="text"
                    value={formData.member2_prn}
                    onChange={(e) => handleInputChange('member2_prn', e.target.value)}
                    placeholder="e.g. 25070123456"
                    inputMode="numeric"
                    maxLength={11}
                    className="w-full bg-[#050814] border border-slate-800 focus:border-cyan-400 rounded-lg px-3 py-2 sm:py-2.5 text-sm sm:text-base font-mono text-white placeholder-slate-500 outline-none transition"
                    disabled={isSubmitting}
                  />
                </div>
              </div>

            </div>

            {/* CONFIRM Submission Action */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-3 py-3 sm:py-3.5 px-6 rounded-xl font-tech font-bold text-sm sm:text-base text-slate-950 bg-gradient-to-r from-cyan-400 via-teal-300 to-cyan-300 hover:from-cyan-300 hover:to-teal-200 transition-all duration-200 shadow-[0_0_25px_rgba(0,240,255,0.45)] hover:shadow-[0_0_35px_rgba(0,240,255,0.7)] flex items-center justify-center gap-2.5 tracking-widest uppercase cursor-pointer disabled:opacity-50"
            >
              <ShieldCheck className="w-5 h-5 text-slate-950" />
              <span>{isSubmitting ? 'CONNECTING PROTOCOL...' : 'CONFIRM CREDENTIALS'}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
