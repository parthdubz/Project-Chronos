import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api.js';

/**
 * Key Blocker tab of the host portal: one switch that locks / unlocks the Windows keys and Tab
 * on every player laptop running KeyBlocker.exe (tools/KeyBlocker), plus the list of laptops
 * that are connected. The exes poll the server every 2 s, so a change reaches them at once.
 */

const POLL_SECONDS = 3;

export default function KeyBlockerPanel() {
  const [state, setState] = useState(null); // { locked, changed_at, clients }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getAdminKeyBlocker());
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, POLL_SECONDS * 1000);
    return () => clearInterval(timer.current);
  }, [load]);

  const toggle = async (locked) => {
    if (busy) return;
    setBusy(true);
    try {
      setState(await api.setAdminKeyBlocker(locked));
      setError('');
    } catch (err) {
      setError(err?.message || 'Could not change the switch.');
    } finally {
      setBusy(false);
    }
  };

  const locked = Boolean(state?.locked);
  const clients = state?.clients || [];
  const online = clients.filter((c) => c.online);
  const blocking = online.filter((c) => c.blocking);

  return (
    <section className="kb">
      {error && <div className="lb-error">{error}</div>}

      <div className={`kb-switch ${locked ? 'locked' : ''}`}>
        <div className="kb-switch-text">
          <span className="kb-state">{locked ? '🔒 KEYS LOCKED' : '🔓 KEYS FREE'}</span>
          <span className="kb-sub">
            {locked
              ? 'Windows keys and Tab are blocked on every connected laptop.'
              : 'Players can use the Windows keys and Tab normally.'}
          </span>
        </div>
        <button
          type="button"
          className={`kb-btn ${locked ? 'unlock' : 'lock'}`}
          disabled={busy || state === null}
          onClick={() => toggle(!locked)}
        >
          {locked ? '🔓 UNLOCK ALL LAPTOPS' : '🔒 LOCK ALL LAPTOPS'}
        </button>
      </div>

      <div className="kb-stats">
        <span>Laptops online <b>{online.length}</b></span>
        <span>Actually blocking <b>{blocking.length}</b></span>
        <span>Offline <b>{clients.length - online.length}</b></span>
      </div>

      <div className="lb-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Laptop</th>
              <th>Address</th>
              <th style={{ textAlign: 'center' }}>Status</th>
              <th style={{ textAlign: 'center' }}>Keys</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {clients.length === 0 ? (
              <tr>
                <td colSpan="5" className="lb-empty">
                  No laptop has connected yet. Run KeyBlocker.exe on a player laptop (server.txt next to it holds
                  this server's address).
                </td>
              </tr>
            ) : (
              clients.map((c) => (
                <tr key={c.name}>
                  <td><div className="team-title">{c.name}</div></td>
                  <td>{c.ip || '-'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`status-badge ${c.online ? 'status-active' : 'status-finished'}`}>
                      {c.online ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {c.online ? (c.blocking ? '🔒 blocked' : '🔓 free') : '-'}
                  </td>
                  <td>{c.seconds_ago < 5 ? 'just now' : `${c.seconds_ago}s ago`}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="tl-hint">
        A laptop that loses the server for ~6 seconds frees its keys on its own (so nobody is ever locked out).
        A server restart also starts with the keys free.
      </p>
    </section>
  );
}
