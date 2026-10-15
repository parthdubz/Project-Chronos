import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api.js';

/**
 * Team Logs tab of the host portal: pick a team on the left, read what it did on the right.
 * Read-only. The server merges game_logs with Round 1 answers and Round 2 AI questions into one
 * plain-language timeline (newest first here), so the host can follow a team live.
 */

const POLL_SECONDS = 4;
const norm = (s) => (s || '').replace(/_/g, '').toUpperCase();

function stageOf(state) {
  switch (norm(state)) {
    case 'COMPLETED':
    case 'DECISIONSUBMITTED':
    case 'FINALREVEAL':
      return 'Finished';
    case 'ROUND3ACTIVE':
      return 'Round 3';
    case 'ROUND2COMPLETED':
    case 'TIMEOUT':
      return 'Round 3 lobby';
    case 'ROUND2ACTIVE':
      return 'Round 2';
    case 'ROUND1COMPLETED':
    case 'ROUND2LOCKED':
      return 'Lobby / Transition';
    case 'ROUND1ACTIVE':
      return 'Round 1';
    default:
      return 'Registered';
  }
}

const ROUND_FILTERS = [
  { key: 'all', label: 'All' },
  { key: '1', label: 'Round 1' },
  { key: '1.5', label: 'Transition' },
  { key: '2', label: 'Round 2' },
  { key: '3', label: 'Round 3' },
];

function ago(iso, now) {
  if (!iso) return 'no activity';
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '-');

export default function TeamLogs() {
  const [teams, setTeams] = useState([]);
  const [selected, setSelected] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [query, setQuery] = useState('');
  const [round, setRound] = useState('all');
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);

  const loadTeams = useCallback(async () => {
    try {
      const data = await api.getAdminTeamActivity();
      setTeams(Array.isArray(data) ? data : []);
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not load team activity.');
    }
  }, []);

  const loadTimeline = useCallback(async (teamId) => {
    if (!teamId) return;
    try {
      setTimeline(await api.getAdminTeamTimeline(teamId));
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not load this team.');
    }
  }, []);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    setTimeline(null);
    loadTimeline(selected);
  }, [selected, loadTimeline]);

  useEffect(() => {
    if (!follow) return undefined;
    const id = setInterval(async () => {
      setNow(Date.now());
      if (busy.current) return;
      busy.current = true;
      try {
        await Promise.all([loadTeams(), selected ? loadTimeline(selected) : null]);
      } finally {
        busy.current = false;
      }
    }, POLL_SECONDS * 1000);
    return () => clearInterval(id);
  }, [follow, selected, loadTeams, loadTimeline]);

  // Most recently active teams first: the ones that are doing something right now.
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams
      .filter((t) => !q || t.team_name.toLowerCase().includes(q))
      .sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
  }, [teams, query]);

  const events = useMemo(() => {
    if (!timeline) return [];
    return timeline.events
      .filter((e) => round === 'all' || String(e.round) === round)
      .slice()
      .reverse();
  }, [timeline, round]);

  const current = teams.find((t) => t.team_id === selected);

  return (
    <section className="tl">
      {error && <div className="lb-error">{error}</div>}
      <div className="tl-bar">
        <input
          className="lb-input"
          placeholder="Find a team..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="tl-hint">
          {follow ? `Live: refreshing every ${POLL_SECONDS}s` : 'Live updates paused'}
        </span>
        <button className={`lb-btn ${follow ? 'on' : ''}`} onClick={() => setFollow((v) => !v)}>
          {follow ? '❚❚ Live' : '▶ Live'}
        </button>
        <button className="lb-btn" onClick={() => { loadTeams(); loadTimeline(selected); }}>↻ Refresh</button>
      </div>

      <div className="tl-split">
        <aside className="tl-teams">
          {list.length === 0 && <div className="lb-empty">No teams yet.</div>}
          {list.map((t) => {
            const idle = t.last_seen ? (now - new Date(t.last_seen).getTime()) / 1000 : Infinity;
            const live = idle < 90 && norm(t.current_state) !== 'COMPLETED';
            return (
              <button
                key={t.team_id}
                type="button"
                className={`tl-team ${selected === t.team_id ? 'sel' : ''}`}
                onClick={() => setSelected(t.team_id)}
              >
                <span className="tl-team-top">
                  <span className={`tl-dot ${live ? 'live' : ''}`} />
                  <b>{t.team_name}</b>
                  <span className="tl-stage">{stageOf(t.current_state)}</span>
                </span>
                <span className={`tl-last tone-${t.last_event?.tone || 'info'}`}>
                  {t.last_event ? t.last_event.title : 'Nothing logged yet'}
                </span>
                <span className="tl-when">{ago(t.last_seen, now)} · {t.events} events</span>
              </button>
            );
          })}
        </aside>

        <div className="tl-feed">
          {!selected ? (
            <div className="lb-empty">Pick a team on the left to see what it is doing.</div>
          ) : (
            <>
              <div className="tl-head">
                <h3>{timeline?.team_name || current?.team_name}</h3>
                <span className="tl-stage">{stageOf(timeline?.current_state || current?.current_state)}</span>
                <div className="tl-chips">
                  {ROUND_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`tl-chip ${round === f.key ? 'on' : ''}`}
                      onClick={() => setRound(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {!timeline ? (
                <div className="lb-empty">Loading...</div>
              ) : events.length === 0 ? (
                <div className="lb-empty">Nothing recorded for this filter yet.</div>
              ) : (
                <ol className="tl-list">
                  {events.map((e, i) => (
                    <li key={`${e.at}-${e.type}-${i}`} className={`tl-ev tone-${e.tone}`}>
                      <span className="tl-time">{clock(e.at)}</span>
                      <span className="tl-tag">
                        {e.round === 1.5 ? 'TR' : e.round ? `R${e.round}` : 'SYS'}
                      </span>
                      <span className="tl-body">
                        <b>{e.title}</b>
                        {e.detail && <small>{e.detail}</small>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {timeline && timeline.total > timeline.events.length && (
                <div className="tl-hint">Showing the latest {timeline.events.length} of {timeline.total} events.</div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
