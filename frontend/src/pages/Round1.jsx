import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api, { assetUrl } from '../services/api.js';
import '../styles/round1.css';

const ERAS = ['PAST', 'PRESENT', 'FUTURE'];
const ERA_META = {
  PAST: { label: 'PAST', sub: 'ARCHIVE • ORIGIN', symbol: '◀' },
  PRESENT: { label: 'PRESENT', sub: 'NOW • ACTIVE', symbol: '●' },
  FUTURE: { label: 'FUTURE', sub: 'PROJECTION • NEXT', symbol: '▶' },
};

const initialZones = { PAST: [], PRESENT: [], FUTURE: [] };

/**
 * Round 1 — Timeline Classification.
 *
 * The backend owns the clock, the scoring and the completion decision:
 *  - the first GET /items assigns this team's items and starts its Round 1 clock;
 *  - the remaining time shown here comes from GET /status, so a page reload cannot reset it;
 *  - on FINISH (or when time runs out) the answers are submitted and POST /finish returns
 *    the score, authentication code and clue, which are handed to `onComplete`.
 */
export default function Round1({ onComplete }) {
  const { team, updateTeamState } = useAuth();
  const teamId = team?.team_id;

  // Round 1 lays out in px (it fills a 1080p screen at 1x). Text is scaled up with the screen via
  // --r1-fs so the small labels stay readable on a 22" monitor without changing the layout.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const fs = Math.min(Math.max(Math.min(window.innerWidth / 1366, window.innerHeight / 768), 1), 1.2);
      root.style.setProperty('--r1-fs', fs.toFixed(2));
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      root.style.removeProperty('--r1-fs');
    };
  }, []);

  const [fragments, setFragments] = useState([]);
  const [zones, setZones] = useState(initialZones);
  const [selectedId, setSelectedId] = useState(null);
  const [deadline, setDeadline] = useState(null); // epoch ms at which the server clock runs out
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [systemState, setSystemState] = useState('BOOTING');
  const [integrity, setIntegrity] = useState(42);
  const [log, setLog] = useState([]);
  const [successFlash, setSuccessFlash] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [hoverEra, setHoverEra] = useState(null);
  const [ghostSrc, setGhostSrc] = useState(null);

  const rootRef = useRef(null);
  const ghostRef = useRef(null);
  const logId = useRef(0);
  const finishingRef = useRef(false);
  const autoTriedRef = useRef(false);
  // Keep the latest callback without making the load effect re-run when the parent re-renders.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const addLog = useCallback((message, type = 'info') => {
    const id = ++logId.current;
    setLog((current) => [
      { id, message, type, time: new Date().toLocaleTimeString([], { hour12: false }) },
      ...current,
    ].slice(0, 6));
  }, []);

  // Load: resume if already completed, otherwise fetch the team's items and sync the clock.
  useEffect(() => {
    if (!teamId) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const before = await api.getRound1Status(teamId);
        if (cancelled) return;
        if (before.completed) {
          updateTeamState('ROUND1_COMPLETED');
          onCompleteRef.current?.(before.result);
          return;
        }

        const items = await api.getRound1Items(teamId);
        const status = await api.getRound1Status(teamId); // the clock is running from the first /items call
        if (cancelled) return;

        setFragments(items.map((item) => ({
          id: item.id,
          image: assetUrl(item.image),
          fragmentCode: `TF-${item.id}`,
        })));
        setDeadline(Date.now() + (status.remaining_seconds ?? status.duration_seconds) * 1000);
        setSystemState('STABLE');
        addLog(`${items.length} temporal fragments recovered`, 'success');
        addLog('CHRONOS core handshake established', 'info');
      } catch (error) {
        if (cancelled) return;
        setSystemState('FAULT');
        setLoadError(error.message || 'Unable to recover fragment stream.');
        addLog(error.message || 'Unable to recover fragment stream', 'error');
      }
    })();

    return () => { cancelled = true; };
  }, [teamId, addLog, updateTeamState]);

  // Countdown, derived from the server deadline so throttled tabs stay accurate.
  useEffect(() => {
    if (!deadline) return undefined;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [deadline]);

  const timeUp = secondsLeft === 0;

  useEffect(() => {
    if (secondsLeft === null || timeUp) return;
    if (secondsLeft <= 60) setSystemState('CRITICAL');
    else if (secondsLeft <= 180) setSystemState('UNSTABLE');
    else if (fragments.length) setSystemState('STABLE');
  }, [secondsLeft, timeUp, fragments.length]);

  const placedIds = useMemo(() => new Set(Object.values(zones).flat()), [zones]);
  const remaining = fragments.filter((fragment) => !placedIds.has(fragment.id));
  const completed = placedIds.size === fragments.length && fragments.length > 0;
  const progress = fragments.length ? Math.round((placedIds.size / fragments.length) * 100) : 0;
  const timerWarning = secondsLeft !== null && secondsLeft <= 180;

  useEffect(() => {
    if (completed) {
      setIntegrity(100);
      setSystemState('RECONSTRUCTED');
      addLog('All temporal fragments routed — ready for final scan', 'success');
    }
  }, [completed, addLog]);

  // A placement is intentionally never judged in the UI. The player can route
  // a fragment into any temporal sector and only the final submission is scored.
  const placeFragment = (fragmentId, era) => {
    if (finishingRef.current || timeUp) return;
    const fragment = fragments.find((item) => item.id === fragmentId);
    if (!fragment) return;

    setZones((current) => {
      const next = {
        PAST: current.PAST.filter((id) => id !== fragmentId),
        PRESENT: current.PRESENT.filter((id) => id !== fragmentId),
        FUTURE: current.FUTURE.filter((id) => id !== fragmentId),
      };
      next[era] = [...next[era], fragmentId];
      return next;
    });

    setSelectedId(null);
    const uniquePlacedCount = new Set(Object.values(zones).flat().filter((id) => id !== fragmentId).concat(fragmentId)).size;
    const nextIntegrity = fragments.length ? 42 + (58 * uniquePlacedCount / fragments.length) : 42;
    setIntegrity(Math.min(100, nextIntegrity));
    setSuccessFlash(true);
    addLog(`${fragment.fragmentCode} routed to ${era} sector`, 'success');
    window.setTimeout(() => setSuccessFlash(false), 400);
  };

  // Return a placed fragment to the recovery field when its thumbnail is double-clicked.
  const unplaceFragment = (fragmentId) => {
    if (finishingRef.current || timeUp) return;
    const wasPlaced = Object.values(zones).some((ids) => ids.includes(fragmentId));
    if (!wasPlaced) return;

    setZones((current) => ({
      PAST: current.PAST.filter((id) => id !== fragmentId),
      PRESENT: current.PRESENT.filter((id) => id !== fragmentId),
      FUTURE: current.FUTURE.filter((id) => id !== fragmentId),
    }));
    setSelectedId(null);
    const remainingPlacedCount = Math.max(0, placedIds.size - 1);
    const nextIntegrity = fragments.length ? 42 + (58 * remainingPlacedCount / fragments.length) : 42;
    setIntegrity(Math.min(100, nextIntegrity));
    addLog(`TF-${fragmentId} returned to recovery field`, 'info');
  };

  // Pointer-based drag: a ghost follows the pointer via transform inside a
  // requestAnimationFrame loop (no React re-render per move), the sector under
  // the pointer is highlighted, and the round's scroll area auto-scrolls near the edges.
  const placeRef = useRef(placeFragment);
  placeRef.current = placeFragment;
  const dragCleanupRef = useRef(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const beginDrag = (event, id) => {
    if (event.button !== 0 || dragCleanupRef.current) return;
    const fragment = fragments.find((item) => item.id === id);
    if (!fragment) return;
    const state = { x: event.clientX, y: event.clientY, active: false, era: null, raf: 0 };
    const startX = event.clientX;
    const startY = event.clientY;

    const eraAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-era]')?.dataset.era ?? null;
    const updateHover = () => {
      const era = eraAt(state.x, state.y);
      if (era !== state.era) {
        state.era = era;
        setHoverEra(era);
      }
    };

    const tick = () => {
      const ghost = ghostRef.current;
      if (ghost) ghost.style.transform = `translate3d(${state.x - 46}px, ${state.y - 46}px, 0) scale(1.06) rotate(-3deg)`;
      const margin = 80;
      const scroller = rootRef.current;
      if (scroller) {
        if (state.y < margin) scroller.scrollBy(0, -Math.ceil((margin - state.y) / 4));
        else if (state.y > window.innerHeight - margin) scroller.scrollBy(0, Math.ceil((state.y - (window.innerHeight - margin)) / 4));
      }
      updateHover();
      state.raf = requestAnimationFrame(tick);
    };

    const onMove = (e) => {
      state.x = e.clientX;
      state.y = e.clientY;
      if (!state.active && Math.hypot(e.clientX - startX, e.clientY - startY) > 5) {
        state.active = true;
        rootRef.current?.classList.add('is-dragging');
        setDraggingId(id);
        setGhostSrc(fragment.image);
        state.raf = requestAnimationFrame(tick);
      }
      if (state.active) updateHover();
    };

    const finish = (e) => {
      cancelAnimationFrame(state.raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', cancel);
      dragCleanupRef.current = null;
      if (!state.active) return;
      rootRef.current?.classList.remove('is-dragging');
      // The click that follows a drag must not trigger sector click-to-place.
      const swallow = (clickEvent) => clickEvent.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      const dropEra = e.type === 'pointerup' ? eraAt(e.clientX, e.clientY) : null;
      if (dropEra) placeRef.current(id, dropEra);
      setDraggingId(null);
      setGhostSrc(null);
      setHoverEra(null);
    };
    const cancel = () => finish({ type: 'pointercancel' });

    dragCleanupRef.current = cancel;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', cancel);
  };

  const buildFinalAnswers = () => {
    const zoneById = {};
    ERAS.forEach((era) => zones[era].forEach((id) => { zoneById[id] = era; }));
    return fragments
      .filter((fragment) => zoneById[fragment.id])
      .map((fragment) => ({ fragment_id: fragment.id, selected_era: zoneById[fragment.id] }));
  };

  // Submit every placed answer, then ask the backend to finish the round. Used by the
  // FINISH button and automatically when the time limit is reached (unplaced items score 0).
  const finishRound = async (auto = false) => {
    if (finishingRef.current || (!auto && !completed)) return;
    finishingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSystemState('PROCESSING');
    addLog(auto ? 'Temporal window expired — sealing arrangement' : 'Scanning final temporal arrangement...', 'info');

    try {
      for (const answer of buildFinalAnswers()) {
        try {
          await api.submitRound1Answer(teamId, answer.fragment_id, answer.selected_era);
        } catch (error) {
          // A retry re-sends answers the server already has; a closed round goes straight to /finish.
          if (/already been submitted/i.test(error.message)) continue;
          if (/time is over|already been completed/i.test(error.message)) break;
          throw error;
        }
      }

      const done = await api.finishRound1(teamId);
      if (!done.round1_completed) throw new Error(done.message || 'Round 1 is not complete yet.');

      setSystemState('AUTHENTICATED');
      addLog('Final scan complete • score sealed', 'success');
      updateTeamState('ROUND1_COMPLETED');
      onCompleteRef.current?.({
        score: done.score,
        auth_code: done.auth_code,
        clue: done.clue,
        completion_time_seconds: done.completion_time_seconds,
        next_round: done.next_round,
      });
    } catch (error) {
      finishingRef.current = false;
      setSubmitting(false);
      setSystemState('FAULT');
      setSubmitError(error.message || 'Submission failed. Try again.');
      addLog(error.message || 'Submission failed', 'error');
    }
  };

  useEffect(() => {
    if (timeUp && fragments.length && !autoTriedRef.current) {
      autoTriedRef.current = true;
      finishRound(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeUp, fragments.length]);

  const formatTime = (value) => {
    const safe = value ?? 0;
    const mins = String(Math.floor(safe / 60)).padStart(2, '0');
    const secs = String(safe % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  };

  const canFinish = !submitting && (completed || timeUp);

  return (
    <div className="r1-root" ref={rootRef}>
      <main className={`chronos-shell ${successFlash ? 'screen-success' : ''}`}>
        <BackgroundEffects />
        <div className="vignette" />
        <header className="topbar">
          <div className="brand-block">
            <div className="brand-name">CHRONOS</div>
          </div>
          <div className="system-readouts">
            <div><span>SYSTEM</span><b className={`status-dot ${systemState.toLowerCase()}`} /> <strong>{systemState}</strong></div>
            <div><span>DRIFT</span><strong className="flicker-text">+08.72ms</strong></div>
            <div><span>TEAM</span><strong>{team?.team_name}</strong></div>
          </div>
        </header>

        <section className="command-row">
          <div>
            <p className="eyebrow">ROUND 01 • TIMELINE FRAGMENT</p>
            <h1>REPAIR THE <span>TIMELINE</span></h1>
            <p className="instruction">Route every corrupted fragment into a temporal sector. CHRONOS will evaluate the final reconstruction when you finish.</p>
          </div>
          <div className={`timer-box ${timerWarning ? 'critical' : ''}`}>
            <span>T-MINUS</span>
            <strong>{formatTime(secondsLeft)}</strong>
            <small>{timeUp ? 'TEMPORAL WINDOW CLOSED' : secondsLeft !== null && secondsLeft <= 60 ? 'TEMPORAL COLLAPSE IMMINENT' : 'WINDOW ACTIVE'}</small>
          </div>
        </section>

        <section className="telemetry-grid">
          <Telemetry title="TIMELINE INTEGRITY" value={`${Math.round(integrity)}%`} progress={integrity} />
          <Telemetry title="FRAGMENTS RESTORED" value={`${placedIds.size} / ${fragments.length}`} progress={progress} />
          <Telemetry title="TEMPORAL DRIFT" value={integrity < 50 ? '+12.31ms' : '+08.72ms'} progress={Math.max(10, integrity - 18)} />
          <div className="score-mask"><span>FINAL SCORE</span><b>•••</b><small>REVEALED ONLY AFTER FINISH</small></div>
        </section>

        <section className="workspace">
          <div className="workspace-head">
            <div><span className="signal-dot" /> FRAGMENT RECOVERY FIELD</div>
            <span>{remaining.length} UNRESOLVED • DRAG OR SELECT → DROP</span>
          </div>
          <div className="fragment-field">
            {loadError && <div className="field-empty field-error"><span>⚠</span>{loadError.toUpperCase()}<small>Check that the backend is running and that Round 1 items are loaded.</small></div>}
            {!loadError && fragments.length === 0 && <div className="field-empty"><span>◈</span>RECOVERING FRAGMENTS...</div>}
            {!loadError && fragments.length > 0 && remaining.length === 0 && <div className="field-empty"><span>◈</span>ALL FRAGMENTS ROUTED — FINAL SCAN READY</div>}
            {remaining.map((fragment, index) => (
              <FragmentCard
                key={fragment.id}
                fragment={fragment}
                index={index}
                selected={selectedId === fragment.id}
                dragging={draggingId === fragment.id}
                onSelect={() => setSelectedId(fragment.id)}
                onPointerDown={(event) => beginDrag(event, fragment.id)}
              />
            ))}
          </div>
        </section>

        <section className="timeline-section">
          <div className="timeline-line" />
          {ERAS.map((era) => (
            <DropZone
              key={era}
              era={era}
              ids={zones[era]}
              fragments={fragments}
              selectedId={selectedId}
              draggingId={draggingId}
              isOver={hoverEra === era}
              onBeginDrag={beginDrag}
              onPlace={placeFragment}
              onSelect={setSelectedId}
              onUnplace={unplaceFragment}
            />
          ))}
        </section>

        {ghostSrc && <div className="drag-ghost" ref={ghostRef} style={{ transform: 'translate3d(-999px, -999px, 0)' }}><img src={ghostSrc} alt="" draggable={false} /></div>}

        <section className="bottom-console">
          <div className="event-log">
            <div className="console-title">CHRONOS EVENT LOG <span>LIVE</span></div>
            <div className="logs">
              {log.map((entry) => <div className={`log ${entry.type}`} key={entry.id}><time>{entry.time}</time><span>{entry.message}</span></div>)}
            </div>
          </div>
          <div className="reconstruction-status">
            <div className="console-title">RECONSTRUCTION STATUS</div>
            <div className="big-progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="status-copy"><b>{progress}%</b><span>{completed ? 'READY FOR FINAL SCAN' : 'TEMPORAL SEQUENCE INCOMPLETE'}</span></div>
            {submitError && <div className="submit-error">⚠ {submitError.toUpperCase()}</div>}
            <button className="primary-button" disabled={!canFinish} onClick={() => finishRound(timeUp)}>
              {submitting
                ? 'SCANNING TIMELINE...'
                : timeUp
                  ? (submitError ? 'RETRY SUBMISSION' : 'SEALING TIMELINE...')
                  : completed
                    ? 'FINISH ROUND • SEAL SCORE'
                    : 'ROUTE ALL FRAGMENTS TO CONTINUE'}
            </button>
          </div>
        </section>

        <footer className="footerbar"><span>CHRONOS CORE • OBSERVING</span><span>SECURE EVENT NODE • 2140</span><span>◉ SIGNAL NOMINAL</span></footer>
      </main>
    </div>
  );
}

function FragmentCard({ fragment, index, selected, dragging, onSelect, onPointerDown }) {
  const rotation = ((index * 17) % 9) - 4;
  const y = ((index * 13) % 7) - 3;
  const [previewOpen, setPreviewOpen] = useState(false);
  const hoverTimerRef = useRef(null);

  const handleMouseEnter = () => {
    if (dragging) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setPreviewOpen(true), 500);
  };

  const handleMouseLeave = () => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setPreviewOpen(false);
  };

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);
  useEffect(() => {
    if (dragging) {
      window.clearTimeout(hoverTimerRef.current);
      setPreviewOpen(false);
    }
  }, [dragging]);

  return (
    <>
      <article
        className={`fragment-card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''}`}
        style={{ '--rot': `${rotation}deg`, '--float': `${y}px` }}
        onClick={onSelect}
        onPointerDown={onPointerDown}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title="Drag to a temporal sector, or select then click a sector. Hover for half a second to inspect."
      >
        <div className="fragment-corner">◈ {fragment.fragmentCode}</div>
        <div className="fragment-image-wrap"><img src={fragment.image} alt="Recovered technology fragment" draggable={false} /><div className="scan-line" /><div className="image-noise" /></div>
        <div className="fragment-meta"><span>UNKNOWN</span><b>{String(fragment.id).padStart(3, '0')}</b></div>
        <div className="fragment-footer"><span>TM-SIGNATURE</span><strong>20██</strong></div>
      </article>
      {previewOpen && !dragging && createPortal(
        <div className="r1-fragment-preview" aria-hidden="true">
          <div className="r1-fragment-preview-card">
            <div className="fragment-corner">◈ {fragment.fragmentCode}</div>
            <div className="r1-fragment-preview-image">
              <img src={fragment.image} alt="" draggable={false} />
            </div>
            <div className="fragment-meta"><span>UNKNOWN</span><b>{String(fragment.id).padStart(3, '0')}</b></div>
            <div className="fragment-footer"><span>TM-SIGNATURE</span><strong>20██</strong></div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function DropZone({ era, ids, fragments, selectedId, draggingId, isOver, onBeginDrag, onPlace, onSelect, onUnplace }) {
  const meta = ERA_META[era];
  const selectedInZone = selectedId && ids.includes(selectedId);
  // Sector name grows with the number of fragments it holds (19px empty → 40px at 12+).
  const growth = Math.min(ids.length, 12) / 12;
  const zoneVars = { '--zone-title': `${19 + growth * 21}px`, '--zone-count': `${18 + growth * 14}px` };
  return (
    <div
      className={`drop-zone ${era.toLowerCase()} ${selectedInZone ? 'selected-zone' : ''} ${isOver ? 'drag-over' : ''}`}
      data-era={era}
      style={zoneVars}
      onClick={() => selectedId && !selectedInZone && onPlace(selectedId, era)}
    >
      <div className="zone-head"><span className="zone-symbol">{meta.symbol}</span><div><h2>{meta.label}</h2><p>{meta.sub}</p></div><b>{ids.length.toString().padStart(2, '0')}</b></div>
      <div className="zone-content">
        {ids.length === 0 && <div className="drop-prompt">DROP TEMPORAL FRAGMENTS HERE</div>}
        {ids.map((id) => {
          const fragment = fragments.find((item) => item.id === id);
          return fragment ? (
            <img
              key={id}
              className={`mini-fragment ${selectedId === id ? 'mini-selected' : ''} ${draggingId === id ? 'dragging' : ''}`}
              src={fragment.image}
              alt="Placed fragment"
              draggable={false}
              onClick={(event) => { event.stopPropagation(); onSelect(id); }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onUnplace(id);
              }}
              onPointerDown={(event) => { event.stopPropagation(); onBeginDrag(event, id); }}
              title="Double-click to return this fragment to the recovery field"
            />
          ) : null;
        })}
      </div>
      <div className="zone-footer">SECTOR • {era} • ROUTE ACCEPTED</div>
    </div>
  );
}

function Telemetry({ title, value, progress }) {
  return <div className="telemetry-card"><div><span>{title}</span><b>{value}</b></div><div className="telemetry-bar"><span style={{ width: `${Math.min(100, progress)}%` }} /></div></div>;
}

function BackgroundEffects() {
  const ticks = Array.from({ length: 12 }, (_, index) => index);
  return (
    <div className="background-effects" aria-hidden="true">
      <div className="r1-grid" />
      <div className="r1-scanlines" />
      <div className="noise" />
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="orb orb-c" />
      <div className="data-stream stream-a">010011 • 7F-A91 • TEMPORAL • 2140</div>
      <div className="data-stream stream-b">CHRONOS::SIG_ERR::RECOVER::PAST_PRESENT_FUTURE</div>
      <div className="corner-circuit circuit-a" />
      <div className="corner-circuit circuit-b" />
      <div className="temporal-clock">
        <div className="clock-ring clock-ring-outer" />
        <div className="clock-ring clock-ring-inner" />
        <div className="clock-ticks">
          {ticks.map((tick) => <span key={tick} style={{ '--tick': tick }} />)}
        </div>
        <div className="clock-hand clock-hour" />
        <div className="clock-hand clock-minute" />
        <div className="clock-hand clock-second" />
        <div className="clock-core" />
        <div className="clock-label">TEMPORAL<br />REFERENCE</div>
      </div>
    </div>
  );
}
