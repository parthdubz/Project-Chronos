import React, { useState, useEffect, useRef } from 'react';
import { soundFx } from '../utils/audio.js';
import { Shield, Zap, RefreshCw } from 'lucide-react';
import ChronosTitle from '../components/ChronosTitle.jsx';

export default function LandingGlitch({ onStart, onAdminMode, isStarting = false }) {
  const canvasRef = useRef(null);
  const [entranceKey, setEntranceKey] = useState(0);

  // Retro Matrix / Glitch Canvas effect in background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const chars = 'CHRONOSGLITCH214001010101ΔΩΨΣΦΞ1001100101001';
    const fontSize = 14;
    const columns = Math.floor(width / fontSize);
    const drops = Array(columns).fill(1);

    const draw = () => {
      ctx.fillStyle = 'rgba(5, 7, 12, 0.15)';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#06b6d4';
      ctx.font = `${fontSize}px 'Share Tech', sans-serif`;

      for (let i = 0; i < drops.length; i++) {
        // Random glitch jitter
        const text = chars[Math.floor(Math.random() * chars.length)];
        const x = i * fontSize;
        const y = drops[i] * fontSize;

        if (Math.random() > 0.85) {
          ctx.fillStyle = '#ec4899'; // Glitch pink
        } else {
          ctx.fillStyle = 'rgba(6, 182, 212, 0.35)'; // Cyan
        }

        ctx.fillText(text, x, y);

        if (y > height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const handleStartClick = () => {
    if (isStarting) return;
    onStart?.();
  };

  return (
    <div className="relative min-h-[calc(100vh-2.25rem)] flex flex-col items-center justify-center p-4 sm:p-6 lg:p-8 overflow-hidden select-none">
      {/* Background Interactive Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none opacity-40 z-0"
      />

      {/* Cyber Grid & CRT Overlay */}
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none z-1" />
      <div className="absolute inset-0 bg-radial from-transparent via-[#05070c]/80 to-[#05070c] pointer-events-none z-1" />

      {/* Main Center Container */}
      <div className="relative z-10 max-w-5xl w-full mx-auto text-center flex flex-col items-center space-y-8 px-4">
        
        {/* System Fault Badge */}
        <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-sm bg-[#040a10]/90 border border-rose-900/70 text-[11px] font-mono tracking-widest shadow-lg backdrop-blur-md">
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-600" />
            </span>
            <span className="text-rose-400 font-bold tracking-widest">FAULT</span>
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">ERR<span className="text-slate-600">::</span><span className="text-cyan-400">Ω</span>-7741</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-400">NODE-7 <span className="text-rose-400/80">OFFLINE</span></span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-500">T+2140.09.01</span>
        </div>

        <div className="py-4 w-full select-none">
          <ChronosTitle key={entranceKey} />
        </div>

        <div className="text-[10px] font-mono tracking-[0.35em] uppercase text-slate-500 -mt-4 flex items-center justify-center gap-3">
          <span className="text-cyan-700">▸</span>
          <span>THE GLITCH ENGINE</span>
          <span className="text-slate-700">—</span>
          <span>CONTAINMENT <span className="text-rose-600/80">FAILED</span></span>
          <span className="text-cyan-700">◂</span>
          <button
            onClick={() => {
              soundFx.playKeystroke();
              setEntranceKey((k) => k + 1);
            }}
            title="Replay title animation"
            className="ml-1 text-slate-700 hover:text-cyan-500 transition cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>

        {/* Immersive Lore Block flanked by Clean Large Club Logos */}
        <div className="w-full flex items-center justify-center gap-4 sm:gap-8 lg:gap-10">
          {/* Left Logo: AI Club */}
          <div className="flex items-center justify-center shrink-0 select-none">
            <img
              src="/images/AI%20club.png"
              alt="AI Club Logo"
              className="w-20 h-20 sm:w-28 sm:h-28 md:w-32 md:h-32 lg:w-36 lg:h-36 object-contain drop-shadow-[0_0_20px_rgba(6,182,212,0.35)] hover:scale-105 transition-transform duration-300"
            />
          </div>

          {/* Immersive Lore / Story Paragraph */}
          <div className="max-w-xl flex-1 bg-[#070c18]/80 backdrop-blur-md border border-cyan-900/50 rounded-xl p-4 sm:p-6 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-cyan-400 to-pink-500" />
            <p className="font-mono text-xs sm:text-sm text-slate-300 leading-relaxed text-left sm:text-center">
              In the year 2140, an irreversible temporal anomaly known as <span className="text-pink-400 font-bold">The Glitch</span> shattered the timeline continuum into volatile fragments. You and your co-pilot represent the vanguard: two operators dispatched to stabilize the core, decode encrypted historical archives, and out-calculate rival teams before timeline collapse.
            </p>
            <div className="mt-3 text-[11px] font-mono text-cyan-400/80 flex items-center justify-center gap-2">
              <Shield className="w-3.5 h-3.5 text-cyan-400" />
              <span>Dual-Operator Neural Link Required</span>
            </div>
          </div>

          {/* Right Logo: SymbiTech */}
          <div className="flex items-center justify-center shrink-0 select-none">
            <img
              src="/images/SymbiTech.png"
              alt="SymbiTech Logo"
              className="w-20 h-20 sm:w-28 sm:h-28 md:w-32 md:h-32 lg:w-36 lg:h-36 object-contain drop-shadow-[0_0_20px_rgba(6,182,212,0.35)] hover:scale-105 transition-transform duration-300"
            />
          </div>
        </div>

        {/* Glowing START Button */}
        <div className="pt-2">
          <button
            onClick={handleStartClick}
            disabled={isStarting}
            className={`group relative inline-flex items-center justify-center px-10 py-4 text-base font-bold font-tech tracking-wider uppercase transition-all duration-300 rounded-lg text-slate-950 bg-gradient-to-r from-cyan-400 via-teal-300 to-cyan-400 hover:from-cyan-300 hover:to-teal-200 shadow-[0_0_30px_rgba(6,182,212,0.6)] hover:shadow-[0_0_50px_rgba(6,182,212,0.9)] hover:scale-105 active:scale-95 border border-cyan-200 ${isStarting ? 'opacity-80 pointer-events-none' : 'cursor-pointer'}`}
          >
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-slate-950 fill-current animate-pulse" />
              <span>START MISSION</span>
            </div>
            <div className="absolute -inset-1 rounded-lg bg-cyan-400/30 blur-sm -z-10 group-hover:opacity-100 opacity-60 transition" />
          </button>
        </div>

        {/* Technical Subtext */}
        <div className="text-[11px] font-mono text-slate-500 flex items-center justify-center gap-4">
          <span>ROUNDS: 3 PHASES</span>
          <span>•</span>
          <span>SECURE SQLITE MASTER</span>
        </div>

      </div>
    </div>
  );
}
