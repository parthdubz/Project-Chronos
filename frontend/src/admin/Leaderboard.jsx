import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api.js';
import PasswordControl from './PasswordControl.jsx';
import TeamLogs from './TeamLogs.jsx';
import KeyBlockerPanel from './KeyBlockerPanel.jsx';
import '../styles/leaderboard.css';

/**
 * Master host leaderboard: the only admin screen (admin token required for the data).
 *
 * Podium + standings table + registered-teams section, in the design of
 * 03-round3-source/frontend/public/leaderboard.html.
 * It shows only what the database recorded: a round with no recorded result is "-",
 * never 0, and a total that is missing a round is marked PARTIAL. It never writes.
 *
 * Props
 *   onLogout  lock the host portal
 */

const POLL_SECONDS = 5;

const norm = (s) => (s || '').replace(/_/g, '').toUpperCase();

function stageOf(t) {
  switch (norm(t.current_state)) {
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
      return 'Round 2 lobby';
    case 'ROUND1ACTIVE':
      return 'Round 1';
    default:
      return 'Registered';
  }
}

const fmt = (v) => (v === null || v === undefined ? '-' : Number.isInteger(v) ? String(v) : Number(v).toFixed(1));

function parseTs(value) {
  if (!value) return null;
  let s = String(value).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function elapsed(from, to) {
  const a = parseTs(from);
  const b = parseTs(to);
  if (!a || !b || b < a) return '--:--';
  const total = Math.floor((b - a) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const clock = (value) => {
  const d = parseTs(value);
  return d ? d.toLocaleTimeString() : '-';
};

const SORTS = {
  rank: { label: 'Rank', fn: (a, b) => a.rank - b.rank || a.team_id - b.team_id },
  name: { label: 'Team name', fn: (a, b) => a.team_name.localeCompare(b.team_name) },
  // Equal total_score falls back to the backend's own rank (already tie-broken by
  // earlier Round 3 finish, then Round 2, then Round 1 - see admin_service.leaderboard()),
  // instead of leaving tied teams in an arbitrary, unstable order.
  score: { label: 'Total score', fn: (a, b) => ((b.total_score ?? -1) - (a.total_score ?? -1)) || (a.rank - b.rank) },
  r1time: { label: 'Round 1 time', fn: (a, b) => ((a.r1_time_diff ?? 1e12) - (b.r1_time_diff ?? 1e12)) || (a.rank - b.rank) },
};

export default function Leaderboard({ onLogout }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [countdown, setCountdown] = useState(POLL_SECONDS);
  const [auto, setAuto] = useState(true);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [sortBy, setSortBy] = useState('rank');
  const [projector, setProjector] = useState(false);
  const [role, setRole] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [toDelete, setToDelete] = useState(null); // team being deleted (confirmation open)
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState('board'); // 'board' | 'logs' | 'keys'
  const [skipOn, setSkipOn] = useState(null); // tester shortcut Ctrl+Shift+Alt+K (null = unknown)
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const data = await api.getAdminLeaderboard();
      setRows(Array.isArray(data) ? data : []);
      setError('');
      setLastSync(new Date());
    } catch (err) {
      setError(err?.status === 401 ? 'Admin session expired. Log in again.' : (err?.message || 'Could not load the leaderboard.'));
    } finally {
      busy.current = false;
      setLoading(false);
      setCountdown(POLL_SECONDS);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.adminRole().then(setRole);
  }, []);

  useEffect(() => {
    if (role !== 'master') return;
    api.getAdminSkipSwitch().then((r) => setSkipOn(Boolean(r?.enabled))).catch(() => setSkipOn(null));
  }, [role]);

  const askDelete = (team) => {
    setConfirmName('');
    setToDelete(team);
  };

  const confirmDelete = async () => {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      await api.deleteAdminTeam(toDelete.team_id);
      setRows((prev) => prev.filter((r) => r.team_id !== toDelete.team_id));
      setToDelete(null);
      setError('');
      load();
    } catch (err) {
      setError(err?.message || 'Could not delete the team.');
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const toggleSkip = async () => {
    if (skipOn === null) return;
    const next = !skipOn;
    setSkipOn(next);
    try {
      const r = await api.setAdminSkipSwitch(next);
      setSkipOn(Boolean(r?.enabled));
    } catch (err) {
      setSkipOn(!next);
      setError(err?.message || 'Could not change the skip shortcut.');
    }
  };

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          load();
          return POLL_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [auto, load]);

  // Projector mode: a clean big-screen view (no PRNs, no controls) and browser fullscreen.
  const toggleProjector = () => {
    setProjector((on) => {
      const next = !on;
      try {
        if (next && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        if (!next && document.fullscreenElement) document.exitFullscreen();
      } catch {
        // fullscreen is optional
      }
      return next;
    });
  };

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setProjector(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const podium = useMemo(() => rows.filter((t) => t.total_score !== null && t.total_score !== undefined).slice(0, 3), [rows]);

  const stages = useMemo(() => ['all', ...Array.from(new Set(rows.map(stageOf)))], [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((t) => stage === 'all' || stageOf(t) === stage)
      .filter(
        (t) =>
          !q ||
          [t.team_name, t.member_1_name, t.member_2_name, t.member_1_prn, t.member_2_prn]
            .some((v) => (v || '').toLowerCase().includes(q)),
      )
      .sort(SORTS[sortBy].fn);
  }, [rows, query, stage, sortBy]);

  const stats = useMemo(() => {
    const finished = rows.filter((t) => t.status === 'FINISHED').length;
    const totals = rows.map((t) => t.total_score).filter((v) => v !== null && v !== undefined);
    return {
      teams: rows.length,
      active: rows.length - finished,
      finished,
      top: totals.length ? Math.max(...totals) : null,
      avg: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
      questions: rows.reduce((n, t) => n + (t.round2_questions_used || 0), 0),
    };
  }, [rows]);

  const exportCsv = async () => {
    try {
      await api.downloadLeaderboardCsv();
    } catch (err) {
      setError(err?.message || 'CSV export failed.');
    }
  };

  const lock = () => {
    api.adminLogout();
    if (document.fullscreenElement) document.exitFullscreen?.();
    onLogout?.();
  };

  const slot = (n) => podium[n - 1];
  const pill = (t) =>
    `R1 ${fmt(t.round1_score)} · TR ${fmt(t.transition_score)} · R2 ${fmt(t.round2_score)} · R3 ${fmt(t.round3_score)}${t.total_complete ? '' : ' · PARTIAL'}`;

  return (
    <div className={`lb ${projector ? 'lb-projector' : ''}`}>
      <div className="lb-scan" />
      <div className="lb-grid" />

      <header className="lb-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="lb-brand-title">PROJECT CHRONOS</span>
            <span className="lb-badge-host">HOST ONLY</span>
          </div>
          <div className="lb-sub">
            Master database: <b>{error ? 'UNREACHABLE' : 'CONNECTED (read-only)'}</b>
            {lastSync && <> · last sync {lastSync.toLocaleTimeString()}</>}
          </div>
        </div>

        <div className="lb-controls lb-sensitive">
          <span className="lb-sync">{auto ? `Syncing in ${countdown}s...` : 'Auto-sync paused'}</span>
          <button className="lb-btn" onClick={load}>↻ Sync Now</button>
          <button className={`lb-btn ${auto ? 'on' : ''}`} onClick={() => setAuto((v) => !v)}>
            {auto ? '❚❚ Auto' : '▶ Auto'}
          </button>
          <button className="lb-btn" onClick={toggleProjector}>⛶ Projector</button>
          <button className="lb-btn lb-btn-csv" onClick={exportCsv}>⤓ Export to CSV</button>
          {role === 'master' && skipOn !== null && (
            <button
              className={`lb-btn ${skipOn ? 'on' : ''}`}
              onClick={toggleSkip}
              title="Tester shortcut Ctrl+Shift+Alt+K: skips the current stage with 0 points. Keep OFF for the real event."
            >
              ⌨ Skip shortcut: {skipOn ? 'ON' : 'OFF'}
            </button>
          )}
          {role === 'master' && (
            <button className="lb-btn" onClick={() => setShowPasswords(true)}>🔑 Passwords</button>
          )}
          {onLogout && <button className="lb-btn lb-btn-lock" onClick={lock}>🔒 Lock Portal</button>}
        </div>
      </header>

      <main className="lb-main">
        {projector && (
          <div className="lb-toolbar">
            <button className="lb-btn" onClick={toggleProjector}>✕ Exit projector</button>
          </div>
        )}

        {error && <div className="lb-error">{error}</div>}

        {!projector && (
          <div className="tl-tabs lb-sensitive">
            <button className={`tl-tab ${tab === 'board' ? 'on' : ''}`} onClick={() => setTab('board')}>
              🏆 Leaderboard
            </button>
            <button className={`tl-tab ${tab === 'logs' ? 'on' : ''}`} onClick={() => setTab('logs')}>
              📜 Team Logs
            </button>
            <button className={`tl-tab ${tab === 'keys' ? 'on' : ''}`} onClick={() => setTab('keys')}>
              ⌨ Key Blocker
            </button>
          </div>
        )}

        {tab === 'logs' && !projector && <TeamLogs />}
        {tab === 'keys' && !projector && <KeyBlockerPanel />}

        {(tab === 'board' || projector) && (<>
        <section className="lb-podium">
          <div className="lb-podium-title">
            <div className="line" />
            <h2>LEADERBOARD</h2>
            <div className="line" />
          </div>

          {podium.length === 0 ? (
            <div style={{ color: '#64748b', fontSize: 12, padding: 20 }}>
              {loading ? 'Loading authoritative records...' : 'Awaiting recorded scores...'}
            </div>
          ) : (
            <div className="lb-stairs">
              {[2, 1, 3].map((n) => {
                const t = slot(n);
                return (
                  <div key={n} className={`lb-pc lb-pc-${n} ${t ? '' : 'empty'}`}>
                    {n === 1 ? <div className="lb-crown">👑</div> : <div className="lb-badge">{String(n).padStart(2, '0')}</div>}
                    <div className="lb-pname" title={t?.team_name}>{t ? t.team_name : 'WAITING...'}</div>
                    <div className="lb-pscore">{t ? fmt(t.total_score) : '-'}</div>
                    <div className="lb-pill">{t ? pill(t) : '-'}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="lb-cards lb-sensitive">
          <div className="lb-card"><span>Teams</span><b>{stats.teams}</b></div>
          <div className="lb-card"><span>In progress</span><b>{stats.active}</b></div>
          <div className="lb-card"><span>Finished</span><b>{stats.finished}</b></div>
          <div className="lb-card"><span>Top score</span><b>{fmt(stats.top)}</b></div>
          <div className="lb-card"><span>Average (recorded)</span><b>{stats.avg === null ? '-' : stats.avg.toFixed(1)}</b></div>
          <div className="lb-card"><span>AI questions asked</span><b>{stats.questions}</b></div>
        </div>

        <div className="lb-filters lb-sensitive">
          <input
            className="lb-input"
            placeholder="Filter by Team Name, Operator, or PRN..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="lb-select" value={stage} onChange={(e) => setStage(e.target.value)}>
            {stages.map((s) => (
              <option key={s} value={s}>{s === 'all' ? 'All stages' : s}</option>
            ))}
          </select>
          <select className="lb-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {Object.entries(SORTS).map(([k, v]) => (
              <option key={k} value={k}>Sort: {v.label}</option>
            ))}
          </select>
        </div>

        <div className="lb-table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Rank</th>
                <th>Team Name</th>
                <th className="lb-sensitive">Operators (Name &amp; PRN)</th>
                <th>R1 Time</th>
                <th style={{ textAlign: 'right' }}>R1</th>
                <th style={{ textAlign: 'right' }}>Transition</th>
                <th style={{ textAlign: 'right' }}>R2</th>
                <th style={{ textAlign: 'right' }}>R3</th>
                <th style={{ textAlign: 'right', color: '#67e8f9' }}>Total</th>
                <th>Total Time</th>
                <th style={{ textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan="11" className="lb-empty">
                    {loading ? 'Loading authoritative records...' : 'No matching teams found in master table.'}
                  </td>
                </tr>
              ) : (
                visible.map((t) => {
                  const rowClass = t.rank === 1 ? 'top-1' : t.rank <= 3 ? 'top-3' : '';
                  const rankClass = t.rank <= 3 ? `rank-${t.rank}` : '';
                  return (
                    <tr key={t.team_id} className={rowClass}>
                      <td className={`rank-cell ${rankClass}`}>#{t.rank}</td>
                      <td>
                        <div className="team-title">{t.team_name}</div>
                        <div className="stage">{stageOf(t)}</div>
                      </td>
                      <td className="lb-sensitive">
                        <div className="member-prn">
                          <strong>{t.member_1_name}</strong> <span className="prn-code">[{t.member_1_prn}]</span>
                        </div>
                        <div className="member-prn">
                          <strong>{t.member_2_name}</strong> <span className="prn-code">[{t.member_2_prn}]</span>
                        </div>
                      </td>
                      <td>{t.r1_time_formatted || '--:--'}</td>
                      <td className="score-cell">{fmt(t.round1_score)}</td>
                      <td className="score-cell">{fmt(t.transition_score)}</td>
                      <td className="score-cell">
                        {fmt(t.round2_score)}
                        {t.round2_questions_used !== null && t.round2_questions_used !== undefined && (
                          <small className={t.round2_provisional ? 'live' : ''}>
                            {t.round2_provisional ? 'LIVE · ' : ''}Q {t.round2_questions_used}/3
                            {t.round2_points_deducted ? ` · -${t.round2_points_deducted}` : ''}
                          </small>
                        )}
                        {t.round2_score === null && <small className="na">not started</small>}
                      </td>
                      <td className="score-cell">{fmt(t.round3_score)}</td>
                      <td className="score-cell total-score">
                        {fmt(t.total_score)}
                        {t.total_score !== null && !t.total_complete && <small className="na">PARTIAL</small>}
                      </td>
                      <td>{t.status === 'FINISHED' ? elapsed(t.r1_started_at, t.r3_completed_at) : '--:--'}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={`status-badge ${t.status === 'FINISHED' ? 'status-finished' : 'status-active'}`}>
                          {t.status === 'FINISHED' ? 'FINISHED' : 'ACTIVE'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Registered teams (same filter / sort as the standings above) */}
        <section className="lb-teams lb-sensitive">
          <div className="lb-podium-title" style={{ margin: '36px auto 20px' }}>
            <div className="line" />
            <h2>TEAMS ({visible.length})</h2>
            <div className="line" />
          </div>

          {visible.length === 0 ? (
            <div className="lb-empty">{loading ? 'Loading team directory...' : 'No teams to show.'}</div>
          ) : (
            <div className="lb-team-grid">
              {visible.map((t) => (
                <div key={t.team_id} className="lb-team">
                  <div className="lb-team-top">
                    <span className="lb-team-id"># {t.team_id}</span>
                    <span className={`status-badge ${t.status === 'FINISHED' ? 'status-finished' : 'status-active'}`}>
                      {stageOf(t).toUpperCase()}
                    </span>
                  </div>
                  <div className="team-title">{t.team_name}</div>
                  <div className="lb-team-members">
                    <div><strong>{t.member_1_name}</strong> <span className="prn-code">[{t.member_1_prn}]</span></div>
                    <div><strong>{t.member_2_name}</strong> <span className="prn-code">[{t.member_2_prn}]</span></div>
                  </div>
                  <div className="lb-team-scores">
                    <span>R1 <b>{fmt(t.round1_score)}</b></span>
                    <span>TR <b>{fmt(t.transition_score)}</b></span>
                    <span>R2 <b>{fmt(t.round2_score)}</b></span>
                    <span>R3 <b>{fmt(t.round3_score)}</b></span>
                    <span className="tot">TOTAL <b>{fmt(t.total_score)}</b></span>
                  </div>
                  <div className="lb-team-foot">
                    <span>Rank #{t.rank}</span>
                    {t.round1_auth_code && <span>R1 code <b>{t.round1_auth_code}</b></span>}
                    <span>
                      {t.status === 'FINISHED'
                        ? `Done ${clock(t.r3_completed_at)}`
                        : 'In progress'}
                    </span>
                  </div>
                  {role === 'master' && (
                    <button
                      type="button"
                      className="lb-btn lb-btn-lock lb-team-del"
                      onClick={() => askDelete(t)}
                      title="Permanently delete this team and all of its data"
                    >
                      🗑 Delete team
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        </>)}
      </main>

      {toDelete && role === 'master' && (
        <div className="pw-overlay" role="dialog" aria-modal="true" aria-label="Delete team">
          <div className="pw-panel" style={{ maxWidth: 520 }}>
            <div className="pw-head">
              <div>
                <h2 style={{ color: '#fda4af' }}>DELETE TEAM</h2>
                <p>
                  This permanently deletes <b>{toDelete.team_name}</b> (#{toDelete.team_id}) and everything
                  recorded for it: scores, answers, AI questions, Round 3 decision and logs. It cannot be undone.
                </p>
              </div>
            </div>
            <div className="pw-add">
              <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                Type the team name to confirm: <code>{toDelete.team_name}</code>
              </p>
              <input
                className="lb-input"
                autoFocus
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder="Team name"
                disabled={deleting}
              />
              <div className="pw-add-actions">
                <button
                  className="lb-btn lb-btn-lock"
                  onClick={confirmDelete}
                  disabled={deleting || confirmName.trim().toLowerCase() !== toDelete.team_name.trim().toLowerCase()}
                >
                  {deleting ? 'Deleting...' : '🗑 Delete permanently'}
                </button>
                <button className="lb-btn" onClick={() => setToDelete(null)} disabled={deleting}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showPasswords && role === 'master' && !projector && (
        <PasswordControl onClose={() => setShowPasswords(false)} />
      )}
    </div>
  );
}
