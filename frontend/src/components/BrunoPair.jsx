import { useEffect, useRef } from 'react';

// Two independent Bruno overlays (D:\Brono-Integration) flanking the AI Club / SymbiTech
// logos on the landing screen (the only place Bruno appears - no admin control): one as
// shipped, one mirrored (scaleX(-1) on the overlay's own host element - the package's
// render loop draws fresh every frame, so the mirror transform mirrors every animation
// too, with no edits to the overlay/animation files). Each mountBrunoOverlay() call runs
// its own independent random-clip selection, so the two sides are never in sync.

const MODULE_BASE = '/bruno-assets';
const BASE_W = 200;
const BASE_H = 300;
const SCALE = 0.9; // "reduce the size by 10%"
const GAP_PX = 8;

export default function BrunoPair({ leftAnchorRef, rightAnchorRef, active = true }) {
  useEffect(() => {
    if (!active) return undefined;
    if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches) {
      return undefined;
    }

    let cancelled = false;
    let destroyLeft = null;
    let destroyRight = null;
    let raf = null;

    const place = (el, mirror, side) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const width = Math.round(BASE_W * SCALE);
      const height = Math.round(BASE_H * SCALE);
      const centerY = rect.top + rect.height / 2;
      const raw = side === 'left' ? rect.left - width - GAP_PX : rect.right + GAP_PX;
      const left = Math.min(Math.max(raw, 4), window.innerWidth - width - 4);
      return {
        width,
        position: {
          top: `${Math.round(centerY - height / 2)}px`,
          left: `${Math.round(left)}px`,
          right: 'auto',
          bottom: 'auto',
          transform: mirror ? 'scaleX(-1)' : 'none',
        },
      };
    };

    async function init() {
      let mods;
      try {
        mods = await Promise.all([
          import(/* @vite-ignore */ `${MODULE_BASE}/bruno-overlay.js`),
          import(/* @vite-ignore */ `${MODULE_BASE}/overlay-config.js`),
        ]);
      } catch {
        return;
      }
      if (cancelled) return;
      const [{ mountBrunoOverlay }, { overlayConfig }] = mods;

      const height = Math.round(BASE_H * SCALE);

      const mountSide = (anchorRef, mirror, side) => {
        const spot = place(anchorRef.current, mirror, side);
        if (!spot) return null;
        return mountBrunoOverlay({
          ...overlayConfig,
          width: `${spot.width}px`,
          height: `${height}px`,
          position: spot.position,
        });
      };

      const mountBoth = () => {
        destroyLeft?.();
        destroyRight?.();
        // AI Club sits to the left of center, so Bruno goes further left, outside it;
        // SymbiTech sits to the right, so its mirror goes further right, outside it.
        destroyLeft = mountSide(leftAnchorRef, false, 'left');
        destroyRight = mountSide(rightAnchorRef, true, 'right');
      };

      mountBoth();

      const onResize = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { mountBoth(); raf = null; });
      };
      window.addEventListener('resize', onResize);

      return () => window.removeEventListener('resize', onResize);
    }

    let cleanupResize;
    init().then((fn) => { cleanupResize = fn; });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      cleanupResize?.();
      destroyLeft?.();
      destroyRight?.();
    };
  }, [leftAnchorRef, rightAnchorRef, active]);

  return null;
}
