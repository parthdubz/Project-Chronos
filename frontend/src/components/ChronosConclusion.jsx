import { useEffect, useRef, useState, useCallback } from 'react';
import { Play, ShieldCheck, Sparkles } from 'lucide-react';
import { soundFx } from '../utils/audio.js';

// Cinematic timeline (seconds). The riser (public/sounds/conclusion_riser.mp3, 6.9 s) plays from 0
// and is cut at its peak (T_RISER_CUT); the merge hits right after the cut.
const T_WARP = 2.5;
const T_WHOOSH1 = 3.4;
const T_WHOOSH2 = 5.3;
const T_RISER_CUT = 6.9; // the file ends here (ffmpeg-trimmed, 35 ms fade)
const T_MERGE = 7.05; // flash + chord + "timelines unified"
const T_FLASH_END = T_MERGE + 0.6;
const T_TITLES = T_MERGE + 0.6;
const T_ACTIONS = T_MERGE + 1.8;
const RISER_SRC = '/sounds/conclusion_riser.mp3';
const IMPACT_SRC = '/sounds/conclusion_impact.mp3'; // 4.5 s, hits at its first frame

// The BLAST at the moment the riser is cut: white-out core, shock rings, rays, sparks, screen shake.
const BLAST_LEN = 1.8;
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const BLAST_RAYS = Array.from({ length: 32 }, (_, i) => ({
  a: (i / 32) * Math.PI * 2 + (hash(i) - 0.5) * 0.12,
  len: 0.45 + hash(i + 50) * 0.55,
  w: 1 + hash(i + 90) * 3,
  pink: hash(i + 130) < 0.2,
}));
const BLAST_SPARKS = Array.from({ length: 90 }, (_, i) => ({
  a: hash(i + 200) * Math.PI * 2,
  speed: 260 + hash(i + 300) * 900,
  life: 0.5 + hash(i + 400) * 1.0,
  size: 1.2 + hash(i + 500) * 2.8,
  pink: hash(i + 600) < 0.18,
}));
const easeOutCubic = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/**
 * ChronosConclusion
 * ----------------
 * Hardware-accelerated, native React canvas cinematic sequence.
 * Visualizes the 3 fractured timelines (Alpha/Future, Beta/Present, Gamma/Past)
 * vibrating, warping into a singularity vortex, and snapping into a single
 * unified prime continuum beam with sound synthesis and debrief handoff.
 * 
 * Props:
 *   onComplete — called when the cinematic finishes
 */
export default function ChronosConclusion({ onComplete }) {
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const startTimeRef = useRef(null);
  const playedCuesRef = useRef(new Set());
  const impactRef = useRef(null);
  const doneRef = useRef(false);

  // Cinematic state stages
  const [badgeText, setBadgeText] = useState('TEMPORAL DIVERGENCE DETECTED');
  const [badgeColor, setBadgeColor] = useState('text-amber-400 border-amber-500/50');
  const [showTitles, setShowTitles] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [flashOpacity, setFlashOpacity] = useState(0);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    soundFx.playAccessGranted();
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    if (onComplete) onComplete();
  }, [onComplete]);

  // Audio synthesis helper for drone and convergence chord
  const playSynthesizedEffects = useCallback((elapsed) => {
    if (typeof window === 'undefined') return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      
      // Warp start: a short glitch blip (the riser file carries the build-up)
      if (elapsed >= T_WARP && !playedCuesRef.current.has('warp')) {
        playedCuesRef.current.add('warp');
        soundFx.playGlitch();
      }

      // Whoosh passes
      if (elapsed >= T_WHOOSH1 && !playedCuesRef.current.has('whoosh-1')) {
        playedCuesRef.current.add('whoosh-1');
        soundFx.playWhoosh();
      }
      if (elapsed >= T_WHOOSH2 && !playedCuesRef.current.has('whoosh-2')) {
        playedCuesRef.current.add('whoosh-2');
        soundFx.playWhoosh();
      }

      // The merge: the riser was cut at its peak, now the cinematic impact hits with the flash.
      // If the file cannot play (missing, blocked) the old synthesized chord is used instead.
      if (elapsed >= T_MERGE && !playedCuesRef.current.has('merge')) {
        playedCuesRef.current.add('merge');
        const synthChord = () => {
          soundFx.playAccessGranted();
          const ctx = new AudioCtx();
          [220, 277.18, 329.63, 440, 554.37, 659.25].forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(0.12 / (idx + 1), ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 3.8);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 3.9);
          });
        };
        const impact = impactRef.current;
        if (impact && soundFx.isSoundEnabled()) {
          try {
            impact.currentTime = 0;
            const started = impact.play();
            if (started && started.catch) started.catch(synthChord);
          } catch (_) {
            synthChord();
          }
        } else if (!impact) {
          synthChord();
        }
      }
    } catch (_) {}
  }, []);

  // Main Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Initial chronon particles
    const particles = [];
    for (let i = 0; i < 160; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        sz: 1 + Math.random() * 2.5,
        color: i % 3 === 0 ? '#06b6d4' : i % 3 === 1 ? '#f59e0b' : '#ec4899',
        alpha: 0.3 + Math.random() * 0.7,
      });
    }

    startTimeRef.current = performance.now();

    // The riser plays from the first frame and ends (cut) at T_RISER_CUT, then the merge hits.
    let riser = null;
    try {
      if (soundFx.isSoundEnabled()) {
        riser = new Audio(RISER_SRC);
        riser.volume = 0.9;
        const started = riser.play();
        if (started && started.catch) started.catch(() => {});
      }
    } catch (_) {
      riser = null; // audio unavailable: the visuals carry on
    }

    try {
      const impact = new Audio(IMPACT_SRC);
      impact.preload = 'auto';
      impact.volume = 0.85; // the file peaks above 0 dBFS
      impactRef.current = impact;
    } catch (_) {
      impactRef.current = null;
    }

    const render = (now) => {
      const elapsed = (now - startTimeRef.current) / 1000;

      // Trigger Audio Cues
      playSynthesizedEffects(elapsed);

      // Compute Timeline Dynamic Phases
      // Phase 1 (0 to 2.5s): Divergence jitter
      // Phase 2 (T_WARP to T_MERGE): Gravitational warping into center (riser plays, cut at its peak)
      // Phase 3 (T_MERGE to T_FLASH_END): Shockwave flash + convergence chord
      // Phase 4 (after): Unified prime beam, titles, metrics
      let warpProgress = 0;
      let mergeStrength = 0;
      let shake = 0;

      if (elapsed > T_WARP && elapsed <= T_MERGE) {
        const p = (elapsed - T_WARP) / (T_MERGE - T_WARP);
        warpProgress = Math.pow(p, 1.8);
        shake = p * 0.7;
      } else if (elapsed > T_MERGE) {
        warpProgress = 1.0;
        mergeStrength = 1.0;
        shake = Math.max(0, 1 - (elapsed - T_MERGE) / 0.7) * 1.8; // blast shake, decays in 0.7 s
      }

      // Flash Trigger
      if (elapsed >= T_MERGE && elapsed < T_FLASH_END) {
        const flashP = 1 - (elapsed - T_MERGE) / (T_FLASH_END - T_MERGE);
        setFlashOpacity(Math.max(0, flashP));
      } else if (elapsed >= T_FLASH_END) {
        setFlashOpacity(0);
      }

      // Status Badge Updates
      if (elapsed >= T_MERGE) {
        setBadgeText('TIMELINES UNIFIED · PRIME CONTINUUM SYNCHRONIZED');
        setBadgeColor('text-emerald-400 border-emerald-500/60');
      } else if (elapsed >= T_WARP) {
        setBadgeText('TEMPORAL RESONANCE COLLAPSE · GRAVITATIONAL WARPING');
        setBadgeColor('text-pink-400 border-pink-500/60');
      }

      // Reveal Titles and Actions
      if (elapsed >= T_TITLES) {
        setShowTitles(true);
      }
      if (elapsed >= T_ACTIONS) {
        setShowActions(true);
      }

      // Draw Background Canvas
      ctx.clearRect(0, 0, width, height);

      // Subtle Cyber Grid
      ctx.save();
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.05)';
      ctx.lineWidth = 1;
      const gridSize = 60;
      for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.restore();

      // Screen Shake during peak collapse
      ctx.save();
      if (shake > 0.02) {
        const sx = (Math.random() - 0.5) * shake * 16;
        const sy = (Math.random() - 0.5) * shake * 16;
        ctx.translate(sx, sy);
      }

      // Chronon Particles
      const centerY = height / 2;
      particles.forEach((p) => {
        if (warpProgress > 0.2 && mergeStrength < 0.95) {
          // Pull into center singularity
          const dx = width / 2 - p.x;
          const dy = centerY - p.y;
          p.x += dx * 0.04 * warpProgress;
          p.y += dy * 0.04 * warpProgress;
        } else if (mergeStrength >= 0.95) {
          // Stream fast along horizontal laser beam
          p.vx = 4 + Math.random() * 8;
          p.vy = (centerY - p.y) * 0.1;
          p.x += p.vx;
          p.y += p.vy;
          if (p.x > width) p.x = -10;
        } else {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0) p.x = width;
          if (p.x > width) p.x = 0;
          if (p.y < 0) p.y = height;
          if (p.y > height) p.y = 0;
        }

        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.alpha;
        ctx.fillRect(p.x, p.y, p.sz, p.sz);
      });
      ctx.globalAlpha = 1;

      // Timeline Strands Definition
      const timelines = [
        {
          id: 'alpha',
          name: 'ALPHA · FUTURE TIMELINE',
          baseY: height * 0.26,
          color: '#06b6d4',
          glowColor: 'rgba(6, 182, 212, 0.75)',
          freq: 0.022,
          amp: 28 * (1 - mergeStrength * 0.8),
          speed: 3.2,
          phase: 0,
        },
        {
          id: 'beta',
          name: 'BETA · PRESENT TIMELINE',
          baseY: height * 0.5,
          color: '#f59e0b',
          glowColor: 'rgba(245, 158, 11, 0.75)',
          freq: 0.016,
          amp: 36 * (1 - mergeStrength * 0.85),
          speed: -2.4,
          phase: 2.1,
        },
        {
          id: 'gamma',
          name: 'GAMMA · PAST TIMELINE',
          baseY: height * 0.74,
          color: '#ec4899',
          glowColor: 'rgba(236, 72, 153, 0.75)',
          freq: 0.03,
          amp: 24 * (1 - mergeStrength * 0.8),
          speed: 4.1,
          phase: 4.2,
        },
      ];

      if (mergeStrength < 0.95) {
        // DRAW THE 3 WARPING TIMELINES
        timelines.forEach((tl, idx) => {
          ctx.save();
          ctx.shadowColor = tl.glowColor;
          ctx.shadowBlur = 18;
          ctx.strokeStyle = tl.color;
          ctx.lineWidth = 3 + warpProgress * 2.5;

          ctx.beginPath();
          const step = 8;
          for (let x = 0; x <= width; x += step) {
            const normY = tl.baseY + Math.sin(x * tl.freq + elapsed * tl.speed + tl.phase) * tl.amp;
            let targetY = normY;

            if (warpProgress > 0.05) {
              targetY = normY + (centerY - normY) * (warpProgress * 0.95);
              const distToCenterX = (x - width / 2) / (width / 2);
              const spiralWave =
                Math.sin(distToCenterX * 6 + elapsed * 8 + idx * 2.1) * (70 * warpProgress * (1 - mergeStrength));
              targetY += spiralWave;
            }

            if (x === 0) ctx.moveTo(x, targetY);
            else ctx.lineTo(x, targetY);
          }
          ctx.stroke();

          // Inner bright core
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          // Strand Label
          if (warpProgress < 0.45) {
            ctx.fillStyle = tl.color;
            ctx.font = '10px monospace';
            ctx.fillText(`[ ${tl.name} ]`, 36, tl.baseY - 14);
          }
          ctx.restore();
        });

        // Singularity Vortex in center during high warp
        if (warpProgress > 0.25) {
          ctx.save();
          const rad = 45 + Math.sin(elapsed * 12) * 15 + warpProgress * 55;
          const grad = ctx.createRadialGradient(width / 2, centerY, 0, width / 2, centerY, rad);
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(0.3, 'rgba(6, 182, 212, 0.9)');
          grad.addColorStop(0.6, 'rgba(236, 72, 153, 0.6)');
          grad.addColorStop(1, 'transparent');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(width / 2, centerY, rad, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      } else {
        // -------------------------------------------------------------
        // THE UNIFIED SINGLE FIXED TIMELINE (PRIME CONTINUUM)
        // -------------------------------------------------------------
        ctx.save();

        // Outer Chronon Aura
        const auraGrad = ctx.createLinearGradient(0, centerY - 60, 0, centerY + 60);
        auraGrad.addColorStop(0, 'rgba(6, 182, 212, 0)');
        auraGrad.addColorStop(0.5, 'rgba(6, 182, 212, 0.35)');
        auraGrad.addColorStop(1, 'rgba(6, 182, 212, 0)');
        ctx.fillStyle = auraGrad;
        ctx.fillRect(0, centerY - 60, width, 120);

        // Radiant Cyan Laser Beam
        ctx.shadowColor = '#22d3ee';
        ctx.shadowBlur = 35;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();

        // Golden-White Laser Core
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 18;
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();

        // Pure White Center Streak
        ctx.shadowBlur = 6;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();

        // Chronon Energy Pulses traveling along beam
        for (let i = 0; i < 6; i++) {
          const pulseX = ((elapsed * 500 + i * (width / 6)) % (width + 200)) - 100;
          const pGrad = ctx.createRadialGradient(pulseX, centerY, 0, pulseX, centerY, 34);
          pGrad.addColorStop(0, '#ffffff');
          pGrad.addColorStop(0.4, '#38bdf8');
          pGrad.addColorStop(1, 'transparent');
          ctx.fillStyle = pGrad;
          ctx.beginPath();
          ctx.arc(pulseX, centerY, 34, 0, Math.PI * 2);
          ctx.fill();
        }

        // Prime Strand Telemetry Text
        ctx.fillStyle = '#67e8f9';
        ctx.font = '11px monospace';
        ctx.fillText('PRIME STRAND · CONTINUUM ZERO [UNIFIED]', 40, centerY - 22);
        ctx.fillText('ENTROPY: 0.00% · FLUX HARMONIZED', width - 300, centerY - 22);

        ctx.restore();
      }

      // ---------------------------------------------------------------------------
      // BLAST: the instant the riser is cut and the merge hits
      // ---------------------------------------------------------------------------
      const bt = elapsed - T_MERGE;
      if (bt >= 0 && bt < BLAST_LEN) {
        const bx = width / 2;
        const maxR = Math.hypot(width, height) * 0.6;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';

        // 1. white-out core that blooms and burns off
        const coreP = bt / 0.55;
        if (coreP < 1) {
          const cr = 60 + easeOutCubic(coreP) * Math.max(width, height) * 0.7;
          const cg = ctx.createRadialGradient(bx, centerY, 0, bx, centerY, cr);
          cg.addColorStop(0, `rgba(255,255,255,${1 - coreP})`);
          cg.addColorStop(0.35, `rgba(190,235,255,${0.75 * (1 - coreP)})`);
          cg.addColorStop(1, 'rgba(34,211,238,0)');
          ctx.fillStyle = cg;
          ctx.beginPath();
          ctx.arc(bx, centerY, cr, 0, Math.PI * 2);
          ctx.fill();
        }

        // 2. three shock rings that sweep outward
        [
          { d: 0, c: '255,255,255', w: 14 },
          { d: 0.1, c: '56,189,248', w: 9 },
          { d: 0.22, c: '244,114,182', w: 6 },
        ].forEach((r) => {
          const rp = (bt - r.d) / 1.1;
          if (rp <= 0 || rp >= 1) return;
          ctx.strokeStyle = `rgba(${r.c},${0.9 * (1 - rp)})`;
          ctx.lineWidth = r.w * (1 - rp) + 1;
          ctx.beginPath();
          ctx.arc(bx, centerY, easeOutCubic(rp) * maxR, 0, Math.PI * 2);
          ctx.stroke();
        });

        // 3. radial rays shooting out of the centre
        const rayP = bt / 0.9;
        if (rayP < 1) {
          BLAST_RAYS.forEach((ray) => {
            const inner = easeOutCubic(rayP) * maxR * 0.25;
            const outer = easeOutCubic(rayP) * maxR * ray.len;
            ctx.strokeStyle = ray.pink
              ? `rgba(244,114,182,${0.85 * (1 - rayP)})`
              : `rgba(186,230,253,${0.85 * (1 - rayP)})`;
            ctx.lineWidth = ray.w * (1 - rayP * 0.6);
            ctx.beginPath();
            ctx.moveTo(bx + Math.cos(ray.a) * inner, centerY + Math.sin(ray.a) * inner);
            ctx.lineTo(bx + Math.cos(ray.a) * outer, centerY + Math.sin(ray.a) * outer);
            ctx.stroke();
          });
        }

        // 4. sparks flying outward
        BLAST_SPARKS.forEach((sp) => {
          const lp = bt / sp.life;
          if (lp >= 1) return;
          const dist = sp.speed * easeOutCubic(lp) * sp.life;
          ctx.fillStyle = sp.pink
            ? `rgba(244,114,182,${1 - lp})`
            : `rgba(207,250,254,${1 - lp})`;
          ctx.beginPath();
          ctx.arc(bx + Math.cos(sp.a) * dist, centerY + Math.sin(sp.a) * dist, sp.size * (1 - lp * 0.5), 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.restore();
      }

      ctx.restore(); // restore screen shake

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (riser) riser.pause();
      window.removeEventListener('resize', resize);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [finish, playSynthesizedEffects]);

  return (
    <div className="fixed inset-0 z-50 bg-[#05070c] select-none overflow-hidden font-space text-white">
      {/* 60fps Canvas Timeline Animation */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

      {/* CRT Scanline & Vignette Overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background:
            'repeating-linear-gradient(to bottom, rgba(0,0,0,0.14) 0 1px, transparent 1px 3px), radial-gradient(ellipse at center, transparent 62%, rgba(0,0,0,0.58) 100%)',
        }}
      />

      {/* Full-Screen Flash Overlay upon Convergence */}
      <div
        className="absolute inset-0 bg-white pointer-events-none z-30 transition-opacity duration-300"
        style={{ opacity: flashOpacity }}
      />

      {/* HUD Telemetry Corners */}
      <div className="absolute top-6 left-6 font-mono text-[0.8125rem] tracking-widest text-cyan-400/80 z-20 pointer-events-none drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]">
        TEMPORAL MATRIX ◈ PROTOCOL 2140<br />
        SYS_STABILITY: CALIBRATING
      </div>
      <div className="absolute top-6 right-6 font-mono text-[0.8125rem] tracking-widest text-cyan-400/80 text-right z-20 pointer-events-none drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]">
        DISPERSION DELTA: FRACTURED<br />
        PARADOX STATE: RESOLVING
      </div>
      <div className="absolute bottom-6 left-6 font-mono text-[0.8125rem] tracking-widest text-cyan-400/80 z-20 pointer-events-none drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]">
        QUANTUM COHERENCE: 3-STRAND FLUX<br />
        GRAVITATIONAL COUPLING: ACTIVE
      </div>
      <div className="absolute bottom-6 right-6 font-mono text-[0.8125rem] tracking-widest text-cyan-400/80 text-right z-20 pointer-events-none drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]">
        UNIT CALLSIGN: ACTIVE ENGINEER<br />
        CHRONOS MAIN KERNEL ◈ SYNC
      </div>

      {/* Dynamic Status Badge */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[25] pointer-events-none">
        <div
          className={`font-mono text-xs sm:text-sm font-bold tracking-[0.25em] uppercase px-6 py-2 rounded-lg bg-black/70 border backdrop-blur-md shadow-[0_0_20px_rgba(0,0,0,0.8)] transition-all duration-500 ${badgeColor}`}
        >
          {badgeText}
        </div>
      </div>

      {/* Center Kinetic Title & Metric Pills */}
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center z-[25] pointer-events-none w-[90%] max-w-4xl transition-all duration-1000 ${
          showTitles ? 'opacity-100 scale-100' : 'opacity-0 scale-90'
        }`}
      >
        <h1 className="font-orbitron font-black text-4xl sm:text-6xl lg:text-7xl tracking-wider text-white drop-shadow-[0_0_40px_rgba(6,182,212,0.9)]">
          TIMELINES <span className="text-cyan-400">MERGED</span>
        </h1>
        <p className="font-mono text-xs sm:text-base tracking-[0.4em] uppercase text-cyan-300 mt-3 drop-shadow-[0_0_12px_rgba(6,182,212,0.6)]">
          THE PRIME CONTINUUM IS RESTORED
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
          <span className="px-4 py-1.5 rounded-full bg-cyan-950/80 border border-cyan-500/50 text-cyan-200 font-mono text-[0.8125rem] tracking-wider shadow-[0_0_15px_rgba(6,182,212,0.3)]">
            ALL 3 BROKEN STRANDS HARMONIZED
          </span>
          <span className="px-4 py-1.5 rounded-full bg-cyan-950/80 border border-cyan-500/50 text-cyan-200 font-mono text-[0.8125rem] tracking-wider shadow-[0_0_15px_rgba(6,182,212,0.3)]">
            PARADOX DECAY: 0.00%
          </span>
          <span className="px-4 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 font-mono text-[0.8125rem] tracking-wider shadow-[0_0_15px_rgba(16,185,129,0.3)]">
            CHRONOS STABILITY: 100%
          </span>
        </div>
      </div>

      {/* Action Buttons (Appears after convergence) */}
      <div
        className={`absolute bottom-10 left-1/2 -translate-x-1/2 z-[35] flex flex-col sm:flex-row items-center gap-4 transition-all duration-700 ${
          showActions ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
      >
        <button
          type="button"
          onClick={finish}
          className="px-8 py-3.5 rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 hover:from-cyan-300 hover:to-sky-400 text-slate-950 font-mono font-bold text-xs uppercase tracking-widest flex items-center gap-2 cursor-pointer shadow-[0_0_30px_rgba(6,182,212,0.6)] hover:shadow-[0_0_45px_rgba(6,182,212,0.9)] hover:scale-105 transition-all"
        >
          <span>VIEW FINAL DEBRIEF & STANDINGS</span>
          <Play className="w-3.5 h-3.5 fill-current" />
        </button>
      </div>
    </div>
  );
}
