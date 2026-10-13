/**
 * Reality Shatter engine: the animation logic, kept apart from the React component.
 *
 *   runRealityShatter({ els, app, soundFx, onSwap, onDone }) -> { cancel }
 *
 * Rendering technique
 *   - Phase 1/2: the LIVE interface is still on screen. Eight persistent "slot" clones of it are
 *     clipped to real UI regions (and thin sweep bands) and displaced / RGB-split independently,
 *     so different regions fail on their own. Cracks, electrical pulses and the impact starburst
 *     are drawn on one 2D canvas, propagating from the impact point.
 *   - Phase 3: the interface is cloned into ~26 irregular shards (jittered spider-web fracture,
 *     merged / split into small, medium and large fragments) clipped with `clip-path`. They sit
 *     inside a CSS `perspective` container and are driven every frame with real 3D transforms
 *     (translateZ toward / away from the camera, rotateX/Y/Z), a shockwave impulse and a lag group.
 *     Canvas debris, light streaks and the shockwave ring are drawn on top.
 *   - Phase 6: a pure-canvas reconstruction (point of light -> jagged line -> branches ->
 *     fragments arriving on curved paths from different depths -> connections -> dissolve +
 *     light wave) while the next round, already mounted, is revealed through an expanding mask.
 *
 * Scheduling: ONE clock (`tl`, advanced by a clamped delta) drives everything. Phases are entered
 * strictly in order (a late frame can never skip an enter hook) and every callback is guarded.
 */

const TL = { fracture: 1.3, shatter: 2.5, collapse: 3.9, voidAt: 4.6, rebuild: 5.3, flash: 6.95, end: 7.45 };
const PHASES = ['instab', 'fracture', 'shatter', 'collapse', 'void', 'rebuild'];
const PHASE_AT = [0, TL.fracture, TL.shatter, TL.collapse, TL.voidAt, TL.rebuild];
const PERSPECTIVE = 900;

// Performance: the original 7.45 s timeline is played SPEED times faster (~4.6 s), and the whole
// effect is cut off after MAX_WALL_MS of real time even if a slow PC renders few frames.
const SPEED = 1.6;
const MAX_WALL_MS = 6000;

const CUES = [
  { t: 0.05, src: '/sounds/glitch.mp3', vol: 0.22, rate: 0.7 }, // buildup: low electrical disturbance
  { t: 1.3, src: '/sounds/glitch2.mp3', vol: 0.35, stopAt: 2.5 }, // first fracture
  { t: 2.5, src: '/sounds/CRT.mp3', vol: 0.85 }, // THE impact (strongest sound)
  { t: 2.62, src: '/sounds/woosh1.mp3', vol: 0.4 }, // shockwave
  { t: 4.6, src: '/sounds/boot.wav', vol: 0.3, rate: 0.5, stopAt: 5.3 }, // void drop
  { t: 5.4, src: '/sounds/reveal.wav', vol: 0.45 }, // reconstruction
  { t: 6.4, src: '/sounds/Woosh3.mp3', vol: 0.35 }, // reassembly whoosh
  { t: 6.95, src: '/sounds/woosh2.mp3', vol: 0.3 }, // final reveal
];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jag(a, b, rand, amount = 0.32, step = 55) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.round(len / step));
  const nx = -(b.y - a.y) / (len || 1);
  const ny = (b.x - a.x) / (len || 1);
  const pts = [{ x: a.x, y: a.y }];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const off = (rand() - 0.5) * 2 * (len / n) * amount;
    pts.push({ x: lerp(a.x, b.x, t) + nx * off, y: lerp(a.y, b.y, t) + ny * off });
  }
  pts.push({ x: b.x, y: b.y });
  return pts;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  pts.forEach((p) => {
    x += p.x;
    y += p.y;
  });
  return { x: x / pts.length, y: y / pts.length };
}

/** Fracture network: irregular shards (small / medium / large) + crack polylines + impact point. */
function buildFracture(W, H, rand) {
  const cx = W * (0.4 + rand() * 0.2);
  const cy = H * (0.36 + rand() * 0.2);
  const maxD = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.25;
  const S = W < 640 ? 4 : 5;
  const fr = [0, 0.1, 0.24, 0.42, 1.25];
  const base = rand() * Math.PI * 2;
  const angles = Array.from({ length: S }, (_, j) => base + ((j + (rand() - 0.5) * 0.6) * Math.PI * 2) / S);

  const v = [[{ x: cx, y: cy }]];
  for (let k = 1; k < fr.length; k++) {
    v.push(
      angles.map((a0) => {
        const r = fr[k] * maxD * (1 + (rand() - 0.5) * 0.3);
        const a = a0 + (rand() - 0.5) * 0.18;
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
      }),
    );
  }

  const cells = [];
  const mergedWithNext = new Set();
  for (let j = 0; j < S; j++) {
    const j2 = (j + 1) % S;
    const j3 = (j + 2) % S;
    cells.push({ pts: [v[0][0], v[1][j], v[1][j2]], ring: 0 });
    for (let k = 1; k < fr.length - 1; k++) {
      const key = `${k}:${j}`;
      if (mergedWithNext.has(`${k}:${(j + S - 1) % S}`)) continue; // already part of the previous large cell
      if (k >= 2 && rand() < 0.5) {
        mergedWithNext.add(key);
        cells.push({
          pts: [v[k][j], v[k][j2], v[k][j3], v[k + 1][j3], v[k + 1][j2], v[k + 1][j]],
          ring: k,
        });
      } else if (k === 1 && rand() < 0.4) {
        const q = [v[k][j], v[k][j2], v[k + 1][j2], v[k + 1][j]];
        cells.push({ pts: [q[0], q[1], q[2]], ring: k });
        cells.push({ pts: [q[0], q[2], q[3]], ring: k });
      } else {
        cells.push({ pts: [v[k][j], v[k][j2], v[k + 1][j2], v[k + 1][j]], ring: k });
      }
    }
  }

  const cracks = [];
  const add = (pts, kind) => {
    const roll = rand();
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    cracks.push({
      pts,
      kind,
      glow: roll < 0.1 ? 2 : roll < 0.45 ? 1 : 0, // 2 magenta, 1 blue-white
      w: kind === 'main' ? 1.1 + rand() * 0.9 : 0.7,
      dist: pts.map((p) => Math.hypot(p.x - cx, p.y - cy)),
      len,
      jitter: (rand() - 0.5) * 0.16, // each crack starts a little earlier / later than its distance says
      phase: rand(),
    });
  };
  for (let j = 0; j < S; j++) {
    const j2 = (j + 1) % S;
    for (let k = 0; k < fr.length - 1; k++) {
      const a = v[k][k === 0 ? 0 : j];
      const radial = jag(a, v[k + 1][j], rand);
      add(radial, 'main');
      if (rand() < 0.6) {
        const at = radial[Math.floor(rand() * (radial.length - 1)) + 1];
        let ang = angles[j] + (rand() - 0.5) * 1.8;
        const branch = [{ x: at.x, y: at.y }];
        const steps = 3 + Math.floor(rand() * 4);
        for (let s = 0; s < steps; s++) {
          ang += (rand() - 0.5) * 1.0;
          const l = 26 + rand() * 60;
          const last = branch[branch.length - 1];
          branch.push({ x: last.x + Math.cos(ang) * l, y: last.y + Math.sin(ang) * l });
        }
        add(branch, 'branch');
      }
    }
    for (let k = 1; k < fr.length; k++) add(jag(v[k][j], v[k][j2], rand, 0.4), 'main');
  }
  return { cx, cy, maxD, cells, cracks };
}

export function runRealityShatter({ els, app, soundFx, onSwap, onDone }) {
  const { root, bg, bands, frags, canvas, scan, msg, flash } = els;
  const timers = new Set();
  const audios = [];
  let cancelled = false;
  let finished = false;
  let swapped = false;
  let raf = 0;
  let tm = 0;
  let tl = 0;
  let last = performance.now();
  let phase = -1;
  const firedCues = new Set();

  const reduced =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!cancelled) fn();
    }, ms);
    timers.add(id);
  };

  const onKeyBlock = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKeyBlock, true);

  const restoreApp = () => {
    if (!app) return;
    app.style.visibility = '';
    app.style.filter = '';
    app.style.transform = '';
    app.style.opacity = '';
  };

  const ensureSwap = () => {
    if (swapped) return;
    swapped = true;
    restoreApp();
    onSwap?.();
  };

  const teardown = () => {
    cancelAnimationFrame(raf);
    clearTimeout(tm);
    timers.forEach(clearTimeout);
    timers.clear();
    window.removeEventListener('keydown', onKeyBlock, true);
    window.removeEventListener('resize', onResize);
    audios.forEach((a) => {
      try {
        a.pause();
      } catch {
        // ignore
      }
    });
    restoreApp();
    document.body.style.overflow = prevOverflow;
    frags.replaceChildren();
    bands.replaceChildren();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  };

  const finish = () => {
    if (finished || cancelled) return;
    finished = true;
    teardown();
    ensureSwap(); // never leave the player on the old round
    onDone?.();
  };

  const cancel = () => {
    if (cancelled || finished) return;
    cancelled = true;
    teardown();
  };

  // ---------------------------------------------------------------- reduced motion
  if (reduced) {
    bg.style.transition = 'opacity .35s ease';
    requestAnimationFrame(() => {
      bg.style.opacity = '1';
    });
    later(ensureSwap, 420);
    later(() => {
      bg.style.transition = 'opacity .4s ease';
      msg.style.opacity = '0';
      bg.style.opacity = '0';
    }, 1000);
    later(finish, 1500);
    return { cancel };
  }

  // ---------------------------------------------------------------- setup
  let W = window.innerWidth;
  let H = window.innerHeight;
  // The effect canvas is drawn at half resolution (CSS stretches it): cracks, sparks and light
  // are soft anyway, and a full-screen canvas was the GPU bottleneck on weaker PCs.
  const dpr = 0.5;
  const rand = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);
  const fx = buildFracture(W, H, rand);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const appRect = app.getBoundingClientRect();
  const cloneApp = () => {
    const node = app.cloneNode(true);
    node.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    node.removeAttribute('id');
    node.style.cssText =
      `position:absolute;left:${appRect.left}px;top:${appRect.top}px;width:${appRect.width}px;` +
      `height:${appRect.height}px;margin:0;max-width:none;transform:none;filter:none;opacity:1;visibility:visible;`;
    node.setAttribute('aria-hidden', 'true');
    node.classList.add('rs-lite'); // strips blur / shadows / animations: a clone is painted dozens of times
    return node;
  };

  const playCue = (cue) => {
    try {
      if (!soundFx.isSoundEnabled()) return;
      const a = new Audio(cue.src);
      a.volume = cue.vol;
      if (cue.rate) a.playbackRate = cue.rate;
      audios.push(a);
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
      if (cue.stopAt) later(() => a.pause(), ((cue.stopAt - cue.t) * 1000) / SPEED);
    } catch {
      // audio unavailable: the visuals carry on
    }
  };

  // ---- independent failure regions: real UI boxes, plus two sweep bands ----
  const pickRegions = () => {
    const out = [];
    const nodes = Array.from(app.querySelectorAll('h1,h2,h3,button,section,article,p,li,div,span'));
    const boxes = nodes
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width >= 70 && r.height >= 20 && r.width < W * 0.95 && r.bottom > 0 && r.top < H && r.left < W);
    for (let tries = 0; tries < 80 && out.length < 3 && boxes.length; tries++) {
      const r = boxes[Math.floor(rand() * boxes.length)];
      const clash = out.some(
        (o) => Math.abs(o.x - r.left) < 40 && Math.abs(o.y - r.top) < 24,
      );
      if (!clash) out.push({ x: r.left - 3, y: r.top - 3, w: r.width + 6, h: Math.min(r.height + 6, 160) });
    }
    while (out.length < 3) {
      out.push({ x: rand() * W * 0.6, y: rand() * H * 0.8, w: 120 + rand() * 260, h: 28 + rand() * 60 });
    }
    return out;
  };
  const regions = pickRegions();
  const slots = [];
  const makeSlot = (kind, region) => {
    const holder = document.createElement('div');
    holder.className = 'rs-slice';
    holder.style.opacity = '0';
    holder.appendChild(cloneApp());
    bands.appendChild(holder);
    slots.push({
      el: holder,
      inner: holder.firstChild,
      kind,
      region,
      next: 0.15 + rand() * 0.55,
      until: 0,
      dx: 0,
      dy: 0,
      y0: rand() * H,
      speed: 380 + rand() * 520,
      step: -1,
    });
  };
  regions.forEach((r) => makeSlot('region', r));
  makeSlot('sweep', null);

  const setSlotClip = (s, x, y, w, h) => {
    s.el.style.clipPath = `polygon(${x}px ${y}px,${x + w}px ${y}px,${x + w}px ${y + h}px,${x}px ${y + h}px)`;
  };

  // ---- lightning ----
  let bolts = [];
  let boltAt = -1;
  const newBolts = (n, spread, nearImpact = false) => {
    bolts = [];
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const len = Math.max(W, H) * (0.1 + rand() * spread);
      const sx = nearImpact ? fx.cx + (rand() - 0.5) * 120 : rand() * W;
      const sy = nearImpact ? fx.cy + (rand() - 0.5) * 120 : rand() * H;
      bolts.push(jag({ x: sx, y: sy }, { x: sx + Math.cos(a) * len, y: sy + Math.sin(a) * len }, rand, 0.5));
    }
  };
  const drawBolts = (alpha) => {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    bolts.forEach((b, i) => {
      ctx.strokeStyle = i % 3 === 0 ? `rgba(255,70,200,${alpha})` : `rgba(110,190,255,${alpha})`;
      ctx.beginPath();
      b.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    });
    ctx.restore();
  };

  // ---- cracks ----
  const traceCrack = (c, R) => {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < c.pts.length; i++) {
      const p = c.pts[i];
      const reach = R - c.jitter * fx.maxD;
      if (c.dist[i] > reach) {
        if (i > 0 && c.dist[i - 1] <= reach) {
          const q = c.pts[i - 1];
          const t = (reach - c.dist[i - 1]) / (c.dist[i] - c.dist[i - 1] || 1);
          ctx.lineTo(lerp(q.x, p.x, t), lerp(q.y, p.y, t));
        }
        break;
      }
      if (!pen) {
        ctx.moveTo(p.x, p.y);
        pen = true;
      } else ctx.lineTo(p.x, p.y);
    }
    return pen;
  };

  const drawCracks = (R, alpha, time) => {
    if (alpha <= 0 || R <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.78 * alpha;
    ctx.strokeStyle = '#000';
    fx.cracks.forEach((c) => {
      ctx.lineWidth = c.w * 2.7;
      if (traceCrack(c, R)) ctx.stroke();
    });
    fx.cracks.forEach((c) => {
      ctx.globalAlpha = (c.glow ? 0.95 : 0.5) * alpha;
      ctx.strokeStyle = c.glow === 2 ? '#ff5fd2' : '#d6ebff';
      ctx.shadowColor = c.glow === 2 ? '#ff2bd6' : '#7cc4ff';
      ctx.shadowBlur = 0;
      ctx.lineWidth = c.w * (c.glow ? 1.05 : 0.65);
      if (traceCrack(c, R)) ctx.stroke();
    });
    // blue-white energy running along the glowing cracks
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowBlur = 0;
    fx.cracks.forEach((c) => {
      if (!c.glow || c.len.length < 2) return;
      const total = c.len[c.len.length - 1];
      const head = ((time * 0.9 + c.phase) % 1.15) * (total + 90);
      const tail = head - 90;
      ctx.strokeStyle = c.glow === 2 ? 'rgba(255,120,225,.95)' : 'rgba(225,245,255,.95)';
      ctx.shadowColor = c.glow === 2 ? '#ff2bd6' : '#9ad4ff';
      ctx.lineWidth = c.w * 1.5;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < c.pts.length; i++) {
        if (c.dist[i] > R) break;
        if (c.len[i] < tail || c.len[i] > head) continue;
        if (!pen) {
          ctx.moveTo(c.pts[i].x, c.pts[i].y);
          pen = true;
        } else ctx.lineTo(c.pts[i].x, c.pts[i].y);
      }
      if (pen) ctx.stroke();
    });
    ctx.restore();
  };

  // ---- camera ----
  let impulseAt = -10;
  let impulseAmp = 0;
  const kick = (amp) => {
    impulseAt = tl;
    impulseAmp = amp;
  };
  const shakeAt = (time) => {
    const e = Math.exp(-(time - impulseAt) / 0.14);
    const a = impulseAmp * e;
    if (a < 0.15) return '';
    return `translate(${((rand() - 0.5) * 2 * a).toFixed(1)}px,${((rand() - 0.5) * 2 * a).toFixed(1)}px)`;
  };

  // ---------------------------------------------------------------- phase: shatter
  const shards = [];
  const debris = [];
  const ringStreaks = [];
  const SHOCK_SPEED = 2300; // px/s

  // ---- shard layers are built ahead of the impact, two per frame ----
  // Creating ~18 clip-path layers (each holds a clone of the interface) in the single frame of the
  // impact froze the page for most of a second. They are created hidden-but-realised
  // (opacity .001) during the first phases instead; buildShards() only has to animate them.
  const shardDoms = [];
  const makeShardDom = (cell) => {
    const c = centroid(cell.pts);
    // Each shard is only as big as its own bounding box: a full-viewport layer per shard
    // meant painting the whole page once per shard (the hitch at the impact).
    const xs = cell.pts.map((q) => q.x);
    const ys = cell.pts.map((q) => q.y);
    const bx = Math.max(0, Math.floor(Math.min(...xs)) - 3);
    const by = Math.max(0, Math.floor(Math.min(...ys)) - 3);
    const bw = Math.max(1, Math.min(W, Math.ceil(Math.max(...xs)) + 3) - bx);
    const bh = Math.max(1, Math.min(H, Math.ceil(Math.max(...ys)) + 3) - by);
    const wrap = document.createElement('div');
    wrap.className = 'rs-frag';
    wrap.style.cssText =
      `left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;right:auto;bottom:auto;` +
      `transform-origin:${c.x - bx}px ${c.y - by}px;`;
    const clip = document.createElement('div');
    clip.className = 'rs-clip';
    clip.style.clipPath = `polygon(${cell.pts.map((q) => `${(q.x - bx).toFixed(1)}px ${(q.y - by).toFixed(1)}px`).join(',')})`;
    const inner = cloneApp();
    inner.style.left = `${appRect.left - bx}px`;
    inner.style.top = `${appRect.top - by}px`;
    clip.appendChild(inner);
    wrap.appendChild(clip);
    const pink = rand() < 0.2;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'rs-edge');
    svg.setAttribute('width', bw);
    svg.setAttribute('height', bh);
    const pg = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    pg.setAttribute('points', cell.pts.map((q) => `${(q.x - bx).toFixed(1)},${(q.y - by).toFixed(1)}`).join(' '));
    pg.setAttribute('fill', 'none');
    pg.setAttribute('stroke', pink ? 'rgba(255,70,200,.85)' : 'rgba(195,230,255,.9)');
    pg.setAttribute('stroke-width', pink ? '1.4' : '1.1');
    svg.appendChild(pg);
    wrap.appendChild(svg);
    wrap.style.opacity = '0.001';
    return wrap;
  };
  const getShardDom = (i) => {
    if (!shardDoms[i]) {
      shardDoms[i] = makeShardDom(fx.cells[i]);
      frags.appendChild(shardDoms[i]);
    }
    return shardDoms[i];
  };
  let prewarmNext = 0;
  const prewarmShards = (n) => {
    frags.style.perspective = `${PERSPECTIVE}px`;
    frags.style.perspectiveOrigin = `${fx.cx}px ${fx.cy}px`;
    for (; n > 0 && prewarmNext < fx.cells.length; n--) getShardDom(prewarmNext++);
  };

  const buildShards = () => {
    const areas = fx.cells.map((c) => polyArea(c.pts));
    const sorted = [...areas].sort((a, b) => b - a);
    const bigCut = sorted[Math.min(2, sorted.length - 1)];
    const smallCut = sorted[Math.floor(sorted.length * 0.55)];
    frags.style.perspective = `${PERSPECTIVE}px`;
    frags.style.perspectiveOrigin = `${fx.cx}px ${fx.cy}px`;

    fx.cells.forEach((cell, i) => {
      const c = centroid(cell.pts);
      const wrap = getShardDom(i);

      const dx0 = c.x - fx.cx;
      const dy0 = c.y - fx.cy;
      const d = Math.hypot(dx0, dy0) || 1;
      const ux = dx0 / d;
      const uy = dy0 / d;
      const area = areas[i];
      let kind;
      if (area >= bigCut) kind = 'foreground';
      else if (area <= smallCut) kind = rand() < 0.5 ? 'scatter' : 'far';
      else kind = ['far', 'near', 'lateral', 'lag'][Math.floor(rand() * 4)];

      const spread = Math.max(W, H);
      const sh = {
        el: wrap,
        cx: c.x,
        cy: c.y,
        ux,
        uy,
        kind,
        dist: d,
        tHit: d / SHOCK_SPEED,
        delay: (d / fx.maxD) * 0.18 + rand() * 0.06,
        dur: 1.0 + rand() * 0.5,
        x: 0,
        y: 0,
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        s: 1,
        fade: 0.7,
        lag: false,
      };
      const side = rand() < 0.5 ? -1 : 1;
      switch (kind) {
        case 'foreground': // large pieces cross the foreground and leave last
          sh.delay = 0.28 + rand() * 0.12;
          sh.dur = 1.45 + rand() * 0.15;
          sh.x = ux * spread * 0.55 + side * spread * 0.2;
          sh.y = uy * spread * 0.45;
          sh.z = 420 + rand() * 130;
          sh.rx = side * (14 + rand() * 18);
          sh.ry = -side * (24 + rand() * 30);
          sh.rz = side * (8 + rand() * 14);
          sh.s = 1.3;
          sh.fade = 0.88;
          break;
        case 'near': // fly toward the camera and grow
          sh.x = ux * spread * 0.5;
          sh.y = uy * spread * 0.5;
          sh.z = 380 + rand() * 160;
          sh.rx = (rand() - 0.5) * 120;
          sh.ry = (rand() - 0.5) * 140;
          sh.rz = (rand() - 0.5) * 70;
          sh.s = 1.15;
          sh.fade = 0.82;
          break;
        case 'far': // recede into darkness
          sh.x = ux * spread * 0.3;
          sh.y = uy * spread * 0.3;
          sh.z = -(1300 + rand() * 900);
          sh.rx = (rand() - 0.5) * 160;
          sh.ry = (rand() - 0.5) * 160;
          sh.rz = (rand() - 0.5) * 90;
          sh.s = 0.7;
          sh.fade = 0.6;
          break;
        case 'lateral': // sweep across the viewport
          sh.x = side * spread * (0.8 + rand() * 0.4);
          sh.y = uy * spread * 0.2 + (rand() - 0.5) * H * 0.3;
          sh.z = (rand() - 0.5) * 220;
          sh.rx = (rand() - 0.5) * 40;
          sh.ry = side * (60 + rand() * 80);
          sh.rz = side * (10 + rand() * 30);
          sh.s = 0.9;
          sh.fade = 0.75;
          break;
        case 'lag': // hesitate, then accelerate away
          sh.delay += 0.2 + rand() * 0.2;
          sh.dur = 1.25;
          sh.x = ux * spread * 0.65;
          sh.y = uy * spread * 0.65;
          sh.z = -(200 + rand() * 500);
          sh.rx = (rand() - 0.5) * 70;
          sh.ry = (rand() - 0.5) * 70;
          sh.rz = (rand() - 0.5) * 50;
          sh.s = 0.8;
          sh.fade = 0.7;
          sh.lag = true;
          break;
        default: // scatter: small pieces spray out fast
          sh.dur = 0.8 + rand() * 0.3;
          sh.x = ux * spread * (0.7 + rand() * 0.5) + (rand() - 0.5) * 200;
          sh.y = uy * spread * (0.7 + rand() * 0.5) + (rand() - 0.5) * 200;
          sh.z = (rand() - 0.5) * 900;
          sh.rx = (rand() - 0.5) * 240;
          sh.ry = (rand() - 0.5) * 240;
          sh.rz = (rand() - 0.5) * 200;
          sh.s = 0.6;
          sh.fade = 0.55;
      }
      // every piece is gone before the void begins
      sh.dur = Math.min(sh.dur, TL.voidAt - 0.12 - TL.shatter - sh.delay);
      shards.push(sh);
    });

    // splinters
    for (let i = 0; i < 40; i++) {
      const cell = fx.cells[Math.floor(rand() * fx.cells.length)];
      const p = cell.pts[Math.floor(rand() * cell.pts.length)];
      const a = Math.atan2(p.y - fx.cy, p.x - fx.cx) + (rand() - 0.5) * 0.9;
      const sp = 380 + rand() * 900;
      debris.push({
        x: p.x,
        y: p.y,
        px: p.x,
        py: p.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        z: 0,
        vz: (rand() - 0.35) * 900,
        size: 3 + rand() * 7,
        rot: rand() * 6.28,
        vr: (rand() - 0.5) * 12,
        pink: rand() < 0.15,
        life: 0.9 + rand() * 0.9,
      });
    }
    for (let i = 0; i < 12; i++) {
      ringStreaks.push({ a: rand() * Math.PI * 2, len: 50 + rand() * 170, off: rand() * 140, speed: 1.1 + rand() * 0.7 });
    }
  };

  const renderShards = (t) => {
    const rel = t - TL.shatter;
    frags.style.transform = shakeAt(t);
    shards.forEach((s) => {
      const u = clamp((rel - s.delay) / s.dur);
      let e;
      if (u <= 0) e = 0;
      else if (s.lag) e = u < 0.35 ? 0.05 * (u / 0.35) : 0.05 + 0.95 * Math.pow((u - 0.35) / 0.65, 2.2);
      else e = Math.pow(u, 2.15);
      // shockwave impulse as the wavefront crosses the shard
      const hit = Math.exp(-Math.pow((rel - s.tHit) / 0.07, 2));
      const imp = 26 * hit * (u < 0.3 ? 1 : 0.4);
      const x = s.x * e + s.ux * imp;
      const y = s.y * e + s.uy * imp;
      const z = s.z * e + (s.kind === 'foreground' ? 30 * hit : 0);
      const sc = lerp(1, s.s, e) * (1 + 0.035 * hit);
      const op = u < s.fade ? 1 : 1 - clamp((u - s.fade) / (1 - s.fade));
      s.el.style.transform =
        `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,${z.toFixed(1)}px) ` +
        `rotateX(${(s.rx * e).toFixed(1)}deg) rotateY(${(s.ry * e).toFixed(1)}deg) ` +
        `rotateZ(${(s.rz * e).toFixed(1)}deg) scale(${sc.toFixed(3)})`;
      s.el.style.opacity = op.toFixed(3);
    });
  };

  const renderDebrisAndShock = (t, dt) => {
    const rel = t - TL.shatter;
    // splinters
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    debris.forEach((d) => {
      if (rel > d.life + 0.1) return;
      d.px = d.x;
      d.py = d.y;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z = Math.min(840, d.z + d.vz * dt);
      d.rot += d.vr * dt;
      const k = PERSPECTIVE / (PERSPECTIVE - d.z);
      const sx = fx.cx + (d.x - fx.cx) * k;
      const sy = fx.cy + (d.y - fx.cy) * k;
      const spx = fx.cx + (d.px - fx.cx) * k;
      const spy = fx.cy + (d.py - fx.cy) * k;
      const a = clamp(1 - rel / d.life);
      const z = d.size * k;
      ctx.globalAlpha = a;
      ctx.strokeStyle = d.pink ? 'rgba(255,100,215,.7)' : 'rgba(170,215,255,.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spx, spy);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.fillStyle = d.pink ? 'rgba(255,130,225,.95)' : 'rgba(225,242,255,.95)';
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(d.rot) * z, sy + Math.sin(d.rot) * z);
      ctx.lineTo(sx + Math.cos(d.rot + 2.3) * z * 0.7, sy + Math.sin(d.rot + 2.3) * z * 0.7);
      ctx.lineTo(sx + Math.cos(d.rot + 4.2) * z * 0.5, sy + Math.sin(d.rot + 4.2) * z * 0.5);
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();

    // shockwave: a sharp, brief distortion ring + streaks (not a soft glow)
    if (rel >= 0 && rel < 0.85) {
      const r = rel * SHOCK_SPEED;
      const a = 1 - clamp(rel / 0.85);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = '#8fd0ff';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(230,244,255,${0.9 * a})`;
      ctx.lineWidth = 3 * a + 0.6;
      ctx.beginPath();
      ctx.arc(fx.cx, fx.cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowColor = '#ff2bd6';
      ctx.strokeStyle = `rgba(255,90,215,${0.55 * a})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(fx.cx, fx.cy, r * 0.93, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
      ringStreaks.forEach((s) => {
        const r0 = Math.max(0, r * s.speed * 0.92 - s.off);
        ctx.strokeStyle = `rgba(190,225,255,${0.55 * a})`;
        ctx.beginPath();
        ctx.moveTo(fx.cx + Math.cos(s.a) * r0, fx.cy + Math.sin(s.a) * r0);
        ctx.lineTo(fx.cx + Math.cos(s.a) * (r0 + s.len * a), fx.cy + Math.sin(s.a) * (r0 + s.len * a));
        ctx.stroke();
      });
      ctx.restore();
    }
  };

  // ---------------------------------------------------------------- phase: reconstruction
  let rb = null;
  const buildRebuild = () => {
    const c0 = { x: W * 0.5, y: H * 0.5 };
    const tilt = (rand() - 0.5) * 0.4;
    const L = W * (W < 640 ? 0.36 : 0.26);
    const lines = [];
    const addLine = (pts, depth) => {
      const len = [0];
      for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      lines.push({ pts, len, total: len[len.length - 1], depth });
    };
    const mains = [
      jag(c0, { x: c0.x + Math.cos(tilt) * L, y: c0.y + Math.sin(tilt) * L }, rand, 0.2, 38),
      jag(c0, { x: c0.x - Math.cos(tilt) * L * 0.9, y: c0.y - Math.sin(tilt) * L * 0.9 }, rand, 0.2, 38),
    ];
    mains.forEach((m) => addLine(m, 0));
    const branchCount = 7;
    for (let i = 0; i < branchCount; i++) {
      const m = mains[i % 2];
      const at = m[1 + Math.floor(rand() * (m.length - 2))];
      let ang = tilt + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.9) + (i % 2 ? Math.PI : 0);
      const pts = [{ x: at.x, y: at.y }];
      const steps = 3 + Math.floor(rand() * 3);
      for (let s = 0; s < steps; s++) {
        ang += (rand() - 0.5) * 0.8;
        const l = 26 + rand() * 52;
        const p = pts[pts.length - 1];
        pts.push({ x: p.x + Math.cos(ang) * l, y: p.y + Math.sin(ang) * l });
      }
      addLine(pts, 1);
      if (rand() < 0.6) {
        // a small secondary split
        const q = pts[1 + Math.floor(rand() * (pts.length - 2))];
        const a2 = ang + (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.6);
        addLine([{ x: q.x, y: q.y }, { x: q.x + Math.cos(a2) * 40, y: q.y + Math.sin(a2) * 40 }], 2);
      }
    }
    // fragment targets: points along the luminous network
    const targets = [];
    lines.forEach((ln) => {
      const n = Math.max(2, Math.round(ln.total / 34));
      for (let i = 1; i <= n; i++) {
        const dist = (i / n) * ln.total;
        let k = 1;
        while (k < ln.len.length - 1 && ln.len[k] < dist) k++;
        const t = (dist - ln.len[k - 1]) / (ln.len[k] - ln.len[k - 1] || 1);
        targets.push({ x: lerp(ln.pts[k - 1].x, ln.pts[k].x, t), y: lerp(ln.pts[k - 1].y, ln.pts[k].y, t) });
      }
    });
    const maxD = fx.maxD;
    const pieces = targets.slice(0, 64).map((tg, i) => {
      const deep = i % 3 !== 0; // 2/3 come from depth (toward the viewer, then redirect), 1/3 from the edges
      let sx;
      let sy;
      if (deep) {
        const a = rand() * Math.PI * 2;
        sx = c0.x + Math.cos(a) * (10 + rand() * 60);
        sy = c0.y + Math.sin(a) * (10 + rand() * 60);
      } else {
        const edge = Math.floor(rand() * 4);
        sx = edge === 0 ? -20 : edge === 1 ? W + 20 : rand() * W;
        sy = edge === 2 ? -20 : edge === 3 ? H + 20 : rand() * H;
      }
      const a = Math.atan2(sy - c0.y, sx - c0.x) + (rand() - 0.5) * 1.3;
      const swing = maxD * (deep ? 0.35 + rand() * 0.4 : 0.15 + rand() * 0.2);
      return {
        sx,
        sy,
        cx: c0.x + Math.cos(a) * swing,
        cy: c0.y + Math.sin(a) * swing,
        tx: tg.x,
        ty: tg.y,
        delay: rand() * 0.45,
        deep,
        size: 3 + rand() * 8,
        rot: rand() * 6.28,
        pink: rand() < 0.14,
      };
    });
    const links = [];
    for (let i = 0; i < pieces.length; i += 2) {
      let best = -1;
      let bd = 1e9;
      for (let j = 0; j < pieces.length; j++) {
        if (j === i) continue;
        const d = Math.hypot(pieces[i].tx - pieces[j].tx, pieces[i].ty - pieces[j].ty);
        if (d < bd && d > 12) {
          bd = d;
          best = j;
        }
      }
      if (best >= 0 && bd < 150) links.push([i, best]);
    }
    rb = { c0, lines, pieces, links };
  };

  const strokeGrown = (ln, g, width, color, blur) => {
    const target = ln.total * g;
    if (target <= 0) return;
    ctx.beginPath();
    ctx.moveTo(ln.pts[0].x, ln.pts[0].y);
    for (let i = 1; i < ln.pts.length; i++) {
      if (ln.len[i] <= target) ctx.lineTo(ln.pts[i].x, ln.pts[i].y);
      else {
        const t = (target - ln.len[i - 1]) / (ln.len[i] - ln.len[i - 1] || 1);
        ctx.lineTo(lerp(ln.pts[i - 1].x, ln.pts[i].x, t), lerp(ln.pts[i - 1].y, ln.pts[i].y, t));
        break;
      }
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.shadowColor = '#7cc4ff';
    ctx.shadowBlur = 0;
    ctx.stroke();
  };

  const bez = (a, b, c, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;

  const renderRebuild = (tr) => {
    if (!rb) return;
    const { c0 } = rb;
    const expand = clamp((tr - 1.15) / 0.55);
    const structAlpha = 1 - easeInOut(expand);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(c0.x, c0.y);
    const sc = 1 + 1.3 * easeOut(expand);
    ctx.scale(sc, sc);
    ctx.translate(-c0.x, -c0.y);

    // the point of light
    const pa = clamp(tr / 0.2);
    if (structAlpha > 0) {
      const pulse = 0.8 + 0.2 * Math.sin(tr * 40);
      const g = ctx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, 16 * pa * pulse);
      g.addColorStop(0, `rgba(255,255,255,${pa * structAlpha})`);
      g.addColorStop(0.4, `rgba(150,205,255,${0.6 * pa * structAlpha})`);
      g.addColorStop(1, 'rgba(100,170,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c0.x, c0.y, 16 * pa * pulse, 0, Math.PI * 2);
      ctx.fill();
    }

    // the luminous fracture network
    rb.lines.forEach((ln) => {
      const start = ln.depth === 0 ? 0.2 : ln.depth === 1 ? 0.55 : 0.8;
      const span = ln.depth === 0 ? 0.7 : 0.5;
      const g = easeOut(clamp((tr - start) / span));
      if (g <= 0 || structAlpha <= 0) return;
      strokeGrown(ln, g, ln.depth === 0 ? 1.8 : 1.1, `rgba(215,238,255,${0.95 * structAlpha})`, ln.depth === 0 ? 14 : 8);
    });

    // fragments arriving from different depths
    ctx.shadowBlur = 0;
    rb.pieces.forEach((p) => {
      const k = clamp((tr - 0.4 - p.delay) / 0.85);
      if (k <= 0) return;
      const e = easeInOut(k);
      const x = bez(p.sx, p.cx, p.tx, e);
      const y = bez(p.sy, p.cy, p.ty, e);
      // deep pieces swell as they come toward the viewer, then settle into the lattice
      const depthScale = p.deep ? 0.35 + 1.4 * Math.sin(Math.PI * Math.min(1, e * 0.85)) : 0.6 + 0.4 * e;
      const z = p.size * depthScale;
      const a = clamp(0.15 + e) * (structAlpha * 0.7 + 0.3 * (1 - expand));
      if (a <= 0.01) return;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.pink ? 'rgba(255,120,220,.95)' : 'rgba(215,238,255,.95)';
      const r = p.rot * (1 - e);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(r) * z, y + Math.sin(r) * z);
      ctx.lineTo(x + Math.cos(r + 2.4) * z * 0.75, y + Math.sin(r + 2.4) * z * 0.75);
      ctx.lineTo(x + Math.cos(r + 4.1) * z * 0.55, y + Math.sin(r + 4.1) * z * 0.55);
      ctx.closePath();
      ctx.fill();
    });

    // energy lines briefly connect selected fragments
    const linkA = clamp((tr - 0.95) / 0.2) * (1 - clamp((tr - 1.45) / 0.25));
    if (linkA > 0) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.shadowColor = '#7cc4ff';
      ctx.shadowBlur = 0;
      rb.links.forEach(([a, b], i) => {
        const flick = 0.55 + 0.45 * Math.sin(tr * 55 + i * 1.7);
        ctx.strokeStyle = `rgba(190,225,255,${linkA * flick * structAlpha})`;
        ctx.beginPath();
        ctx.moveTo(rb.pieces[a].tx, rb.pieces[a].ty);
        ctx.lineTo(rb.pieces[b].tx, rb.pieces[b].ty);
        ctx.stroke();
      });
    }
    ctx.restore();

    // a soft wave of light passes through the screen
    const wave = clamp((tr - 1.2) / 0.6);
    if (wave > 0 && wave < 1) {
      const x = lerp(-0.15 * W, 1.15 * W, easeInOut(wave));
      const g = ctx.createLinearGradient(x - 160, 0, x + 160, 0);
      g.addColorStop(0, 'rgba(120,180,255,0)');
      g.addColorStop(0.5, `rgba(190,225,255,${0.3 * Math.sin(Math.PI * wave)})`);
      g.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(x - 160, 0, 320, H);
      ctx.restore();
    }
  };

  // ---------------------------------------------------------------- per-frame rendering
  let lastText = '';
  const setText = (text, opacity) => {
    if (text !== lastText) {
      msg.textContent = text;
      lastText = text;
    }
    msg.style.opacity = String(opacity);
  };

  const renderUnstable = (t) => {
    const p1 = clamp(t / TL.fracture);
    const p2 = clamp((t - TL.fracture) / (TL.shatter - TL.fracture));
    bg.style.opacity = String(lerp(0, 0.5, easeOut(clamp(t / TL.shatter))));
    scan.style.opacity = String(clamp(t / 0.6) * 0.5);

    // the live interface only darkens a little and freezes for a moment; failures live in the slots
    const frozen = t > 0.62 && t < 0.78;
    const shake = shakeAt(t);
    if (app) {
      app.style.filter = `brightness(${(1 - 0.28 * easeOut(clamp(t / TL.shatter))).toFixed(3)})`;
      app.style.transform = shake;
    }
    bands.style.transform = shake;
    canvas.style.transform = shake;

    const intensity = 0.25 + 0.75 * p1 + 0.6 * p2;
    slots.forEach((s) => {
      if (frozen) {
        s.el.style.opacity = '0';
        s.until = 0;
        s.next = Math.max(s.next, 0.8);
        return;
      }
      if (t >= s.next && t >= s.until) {
        // start an independent failure burst
        s.until = t + 0.07 + rand() * 0.16;
        s.next = s.until + 0.12 + rand() * (0.5 - 0.25 * Math.min(1, intensity));
        s.dx = (rand() < 0.5 ? -1 : 1) * (3 + rand() * 12) * intensity;
        s.dy = (rand() - 0.5) * 4;
        if (s.kind === 'region') {
          const r = s.region;
          setSlotClip(s, r.x, r.y, r.w, r.h);
        } else {
          const h = 6 + rand() * 18;
          s.y0 = rand() * (H - h);
          setSlotClip(s, 0, s.y0, W, h);
        }
        const split = 2 + rand() * 3 * intensity;
        s.inner.style.filter = '';
        s.dx += split; // keep the misalignment; the RGB-split filter was too costly
      }
      const live = t < s.until;
      s.el.style.opacity = live ? '1' : '0';
      if (live) {
        const step = Math.floor(t * 30);
        if (step !== s.step) {
          s.step = step;
          const j = (rand() - 0.5) * 3;
          s.inner.style.transform = `translate(${(s.dx + j).toFixed(1)}px,${s.dy.toFixed(1)}px)`;
        }
        if (s.kind === 'sweep') {
          // the band keeps travelling while it is alive
          const y = (s.y0 + (t - (s.until - 0.2)) * s.speed) % (H - 10);
          s.el.style.transform = `translateY(${(y - s.y0).toFixed(0)}px)`;
        } else s.el.style.transform = '';
      }
    });

    // low-frequency electrical disturbance
    if (t > boltAt) {
      newBolts(t < TL.fracture ? 2 : 4, 0.3, t >= TL.fracture);
      boltAt = t + 0.1;
    }
    drawBolts(0.14 + 0.22 * p1);

    // the impact point: a tiny sharp fracture first, then cracks that travel outward
    if (t >= TL.fracture - 0.18) {
      const grow = clamp((t - (TL.fracture - 0.18)) / (TL.shatter - TL.fracture + 0.18));
      const R = easeOutExpo(grow) * fx.maxD * 1.02;
      drawCracks(R, 1, t);
      // starburst at the instant of impact
      const sb = clamp((t - TL.fracture) / 0.2);
      if (t >= TL.fracture && sb < 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(235,246,255,${1 - sb})`;
        ctx.shadowColor = '#9ad4ff';
        ctx.shadowBlur = 0;
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + 0.3;
          const l = (14 + (i % 3) * 16) * (0.4 + sb);
          ctx.lineWidth = 1.6 * (1 - sb) + 0.4;
          ctx.beginPath();
          ctx.moveTo(fx.cx + Math.cos(a) * 3, fx.cy + Math.sin(a) * 3);
          ctx.lineTo(fx.cx + Math.cos(a) * l, fx.cy + Math.sin(a) * l);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  };

  const render = (t, dt) => {
    ctx.clearRect(0, 0, W, H);

    CUES.forEach((c, i) => {
      if (t >= c.t && !firedCues.has(i)) {
        firedCues.add(i);
        playCue(c);
      }
    });

    if (t < TL.shatter) {
      renderUnstable(t);
    } else if (t < TL.collapse) {
      // SHATTER: the 3D pieces + shockwave + debris
      renderShards(t);
      renderDebrisAndShock(t, dt);
      const rel = t - TL.shatter;
      drawCracks(fx.maxD * 1.3, clamp(1 - rel / 0.18), t); // the cracks give way to the shards
      const f = rel < 0.14 ? Math.sin((rel / 0.14) * Math.PI) * 0.5 : 0; // one brief blue-white flash
      flash.style.opacity = String(f);
    } else if (t < TL.voidAt) {
      // COLLAPSE: stragglers leave, the remaining lines are pulled back into the origin
      flash.style.opacity = '0';
      renderShards(t);
      renderDebrisAndShock(t, dt);
      const k = clamp((t - TL.collapse) / (TL.voidAt - TL.collapse));
      drawCracks(fx.maxD * (1 - easeInOut(k)), 0.9 * (1 - k * 0.6), t);
    } else if (t < TL.rebuild) {
      // VOID: absolute black and stillness (nothing is drawn)
      bg.style.opacity = '1';
    } else {
      renderRebuild(t - TL.rebuild);
      // system messages
      if (t < 5.8) setText('', 0);
      else if (t < 6.35) setText('TIMELINE FRACTURE DETECTED', clamp(Math.min((t - 5.8) / 0.12, (6.35 - t) / 0.12)));
      else setText('', 0);

      // the next round (already mounted) glitches into view: the black cover tears into
      // flickering horizontal bars that thin out until the whole screen is visible
      const GS = 6.6;
      const GE = 7.25;
      bg.style.webkitMaskImage = '';
      bg.style.maskImage = '';
      flash.style.opacity = '0';
      if (t >= GE) {
        bg.style.opacity = '0';
      } else if (t >= GS) {
        const p = (t - GS) / (GE - GS); // 0 -> 1
        // the cover itself stutters on and off, more and more often off
        bg.style.opacity = rand() < 1 - 1.15 * p ? '1' : '0';
        // torn bars (with a cyan / pink fringe) over the revealed screen
        const bars = Math.round(10 * (1 - p));
        for (let i = 0; i < bars; i++) {
          const y = rand() * H;
          const h = 3 + rand() * 30 * (1 - p * 0.6);
          const sh = (rand() - 0.5) * 36 * (1 - p);
          ctx.fillStyle = 'rgba(0,0,0,0.92)';
          ctx.fillRect(sh, y, W, h);
          ctx.fillStyle = 'rgba(0,230,255,0.55)';
          ctx.fillRect(sh - 3, y, W, 1.5);
          ctx.fillStyle = 'rgba(255,40,160,0.55)';
          ctx.fillRect(sh + 3, y + h - 1.5, W, 1.5);
        }
      }
      if (t > 7.2) canvas.style.opacity = String(1 - clamp((t - 7.2) / 0.25));
    }
  };

  // ---------------------------------------------------------------- phase hooks (entered in order)
  const enter = [
    () => {}, // instab
    () => kick(5), // fracture: the impact has a camera impulse
    () => {
      buildShards();
      kick(7);
      bands.replaceChildren();
      bands.style.transform = '';
      canvas.style.transform = '';
      scan.style.opacity = '0';
      bg.style.opacity = '1';
      if (app) {
        app.style.visibility = 'hidden';
        app.style.filter = '';
        app.style.transform = '';
      }
    },
    () => {}, // collapse
    () => {
      // void: nothing visible, the next round mounts underneath
      frags.replaceChildren();
      frags.style.transform = '';
      shards.length = 0;
      debris.length = 0;
      bg.style.opacity = '1';
      flash.style.opacity = '0';
      ensureSwap();
    },
    () => {
      canvas.style.transform = '';
      buildRebuild();
    },
  ];

  // ---------------------------------------------------------------- clock
  function onResize() {
    // geometry was built for the old viewport: jump to the void and rebuild the reconstruction
    // for the new size instead of showing misaligned shards.
    if (cancelled || finished) return;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (tl < TL.voidAt) tl = TL.voidAt;
    if (phase >= 5) buildRebuild();
  }
  window.addEventListener('resize', onResize);

  const startedAt = performance.now();
  let frames = 0;
  function step(now) {
    if (now - startedAt > MAX_WALL_MS) {
      finish(); // slow device: skip what is left, the next round is swapped in by finish()
      return;
    }
    // A machine that cannot hold ~20 fps would make the click feel dead for seconds: after a
    // dozen frames, give up on the effect and go straight to the next round.
    frames += 1;
    if (frames === 12 && (now - startedAt) / frames > 60) {
      finish();
      return;
    }
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000)) * SPEED;
    last = now;
    tl += dt;
    if (phase < 2) prewarmShards(2); // build the shatter layers ahead of time, a couple per frame
    while (phase < PHASES.length - 1 && tl >= PHASE_AT[phase + 1]) {
      phase += 1;
      enter[phase]();
    }
    if (phase < 0) {
      phase = 0;
      enter[0]();
    }
    render(tl, dt);
    if (tl >= TL.end) finish();
  }

  function run(now) {
    if (cancelled || finished) return;
    try {
      step(now);
    } catch (err) {
      console.error('RealityShatter failed, continuing to the next round:', err);
      finish();
      return;
    }
    if (!cancelled && !finished) schedule();
  }
  function schedule() {
    raf = requestAnimationFrame((now) => {
      clearTimeout(tm);
      run(now);
    });
    // a throttled / hidden view may not deliver rAF: the same step is driven by a timer instead
    tm = setTimeout(() => {
      cancelAnimationFrame(raf);
      run(performance.now());
    }, 120);
  }

  phase = 0;
  enter[0]();
  schedule();

  return { cancel };
}
