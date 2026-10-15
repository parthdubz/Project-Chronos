/**
 * PROJECT CHRONOS — API client
 *
 * Base URL:
 *  - Production: leave VITE_API_BASE unset -> same origin (FastAPI serves the built frontend).
 *  - Development: frontend/.env sets VITE_API_BASE (e.g. http://localhost:8000).
 *
 * Authentication:
 *  - Team calls (rounds 1-3) carry the team's session token (issued at login) in
 *    X-Team-Token. A 401 means the stored session is no longer valid: the
 *    'chronos:session-invalid' event tells the app to return to the login screen.
 *  - Admin calls carry the admin bearer token kept in sessionStorage (this tab only).
 */
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

// Must match AuthContext's SESSION_KEY (not imported: AuthContext imports this file).
const TEAM_SESSION_KEY = 'chronos_team_session';
const ADMIN_TOKEN_KEY = 'chronos_admin_token';

export const SESSION_INVALID_EVENT = 'chronos:session-invalid';
export const ADMIN_INVALID_EVENT = 'chronos:admin-invalid';

function teamToken() {
  try {
    return JSON.parse(localStorage.getItem(TEAM_SESSION_KEY) || 'null')?.session_token || '';
  } catch {
    return '';
  }
}

function adminToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(token) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // sessionStorage unavailable: the admin simply logs in again
  }
}

export function hasAdminToken() {
  return Boolean(adminToken());
}

async function apiRequest(endpoint, options = {}, auth = 'team') {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  if (auth === 'team') {
    const token = teamToken();
    if (token) headers['X-Team-Token'] = token;
  } else if (auth === 'admin') {
    const token = adminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  } catch {
    const error = new Error('Cannot reach the CHRONOS server. Check the connection and try again.');
    error.status = 0;
    throw error;
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message = data?.detail || data?.message || `HTTP ${res.status}: ${res.statusText}`;
    const error = new Error(typeof message === 'string' ? message : 'Request failed.');
    error.status = res.status;
    error.data = data;

    if (res.status === 401 && auth === 'team') {
      window.dispatchEvent(new CustomEvent(SESSION_INVALID_EVENT));
    }
    if (res.status === 401 && auth === 'admin') {
      setAdminToken('');
      window.dispatchEvent(new CustomEvent(ADMIN_INVALID_EVENT));
    }
    throw error;
  }
  return data;
}

// Round 1 endpoints report business errors as 200 + { error: "..." } (see
// docs/round1_api_contract.md), so those are turned into thrown errors here.
function unwrapRound1(data) {
  if (data?.error) {
    const error = new Error(data.error);
    error.status = 200;
    throw error;
  }
  return data;
}

// Round 1 image paths come from the backend (e.g. "/static/round1/x.png", may contain spaces).
export function assetUrl(path) {
  return `${API_BASE}${encodeURI(path)}`;
}

const teamQuery = (teamId) => `team_id=${encodeURIComponent(teamId)}`;

export const api = {
  // --- Auth: POST /api/auth/login (registers a new team, or logs in a returning team) ---
  login(payload) {
    return apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, 'none');
  },

  // --- Secure mode: public switch, and violation reports (fire-and-forget) ---
  async getSecurityConfig() {
    try {
      const data = await apiRequest('/api/security/config', {}, 'none');
      return Boolean(data?.secure_mode);
    } catch {
      return true; // cannot reach the server: stay strict
    }
  },

  reportSecurityEvent(teamId, kind, detail = '') {
    return apiRequest('/api/security/event', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, kind, detail }),
    }).catch(() => null);
  },

  // --- Auth: GET /api/auth/session (validates a stored session after a page reload) ---
  async getSession(teamId) {
    try {
      return await apiRequest(`/api/auth/session?${teamQuery(teamId)}`);
    } catch (err) {
      if (err.status === 404 || err.status === 401) return { notFound: true };
      return null; // network / server hiccup: caller keeps the session
    }
  },

  // --- Transition Round: clue id + attempts (first call allocates the team's clue) ---
  async getTransitionState(teamId) {
    return apiRequest(`/api/transition/state?${teamQuery(teamId)}`);
  },

  // --- Tester shortcut (only works when the server runs with CHRONOS_ENABLE_SKIP=1) ---
  async devSkipRound(teamId) {
    return apiRequest('/api/dev/skip-round', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId }),
    });
  },

  // --- Transition Round: read-only position (clue assigned / stopwatch started / completed) ---
  async getTransitionProgress(teamId) {
    try {
      return await apiRequest(`/api/transition/progress?${teamQuery(teamId)}`);
    } catch {
      return null;
    }
  },

  // --- Transition Round: the team started the stopwatch (idempotent) ---
  async startTransition(teamId) {
    return apiRequest('/api/transition/start', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId }),
    });
  },

  // --- Transition Round: END STOPWATCH, the duration is frozen on the server (idempotent) ---
  async stopTransition(teamId) {
    return apiRequest('/api/transition/stop', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId }),
    });
  },

  // --- Transition Round: submit the password found at the physical destination ---
  async verifyTransitionPassword(teamId, password) {
    return apiRequest('/api/transition/verify', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, password }),
    });
  },

  // --- Round 1: GET /api/round1/status (state, server-side remaining time, result once done) ---
  async getRound1Status(teamId) {
    const data = await apiRequest(`/api/round1/status?${teamQuery(teamId)}`);
    return unwrapRound1(data);
  },

  // --- Round 1: GET /api/round1/items (first call assigns the team's items and starts its clock) ---
  async getRound1Items(teamId) {
    const data = await apiRequest(`/api/round1/items?${teamQuery(teamId)}`);
    return unwrapRound1(data);
  },

  // --- Round 1: POST /api/round1/submit (one classification per item) ---
  async submitRound1Answer(teamId, itemId, answer) {
    const query = new URLSearchParams({ team_id: teamId, item_id: itemId, answer });
    const data = await apiRequest(`/api/round1/submit?${query}`, { method: 'POST' });
    return unwrapRound1(data);
  },

  // --- Round 1: POST /api/round1/finish (backend decides whether the round is really complete) ---
  async finishRound1(teamId) {
    const data = await apiRequest(`/api/round1/finish?${teamQuery(teamId)}`, {
      method: 'POST',
    });
    return unwrapRound1(data);
  },

  // --- Round 3 (Round 2 runs inside its own page, public/round2/index.html) ---
  // GET: may this team start Round 3 yet? No side effects.
  getRound3Availability(teamId) {
    return apiRequest(`/api/round3/availability?${teamQuery(teamId)}`);
  },

  // POST: the Lobby's START ROUND 3 button (idempotent).
  startRound3(teamId) {
    return apiRequest('/api/round3/start', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId }),
    });
  },

  // GET: the team's case once Round 3 was started (read-only).
  getRound3Scenario(teamId) {
    return apiRequest(`/api/round3/scenario?${teamQuery(teamId)}`);
  },

  // POST: the final accusation. The server requires at least two evidence items.
  submitRound3Decision(teamId, selectedCandidateId, selectedEvidenceIds = []) {
    return apiRequest('/api/round3/submit', {
      method: 'POST',
      body: JSON.stringify({
        team_id: teamId,
        selected_candidate_id: selectedCandidateId,
        selected_evidence_ids: selectedEvidenceIds,
      }),
    });
  },

  // GET: debrief, available only after this team's own submission.
  getRound3Verdict(teamId) {
    return apiRequest(`/api/round3/verdict?${teamQuery(teamId)}`);
  },

  // --- Admin (host only) ---
  async adminLogin(password) {
    const data = await apiRequest('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }, 'none');
    setAdminToken(data.token);
    return data;
  },

  async adminSession() {
    try {
      await apiRequest('/api/admin/session', {}, 'admin');
      return true;
    } catch {
      return false;
    }
  },

  adminLogout() {
    setAdminToken('');
  },

  // 'master' | 'temp' (a one-time password session cannot manage passwords) | '' when invalid
  async adminRole() {
    try {
      const data = await apiRequest('/api/admin/session', {}, 'admin');
      return data?.role || 'master';
    } catch {
      return '';
    }
  },

  // --- delete a team and all of its data (master only) ---
  deleteAdminTeam(teamId) {
    return apiRequest(`/api/admin/teams/${encodeURIComponent(teamId)}`, { method: 'DELETE' }, 'admin');
  },

  // --- tester skip shortcut switch (master only) ---
  getAdminSkipSwitch() {
    return apiRequest('/api/admin/dev-skip', {}, 'admin');
  },

  setAdminSkipSwitch(enabled) {
    return apiRequest('/api/admin/dev-skip', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }, 'admin');
  },

  // --- access password control (master only) ---
  listAdminPasswords() {
    return apiRequest('/api/admin/passwords', {}, 'admin');
  },

  addAdminPasswords({ passwords = [], generate = 0 }) {
    return apiRequest('/api/admin/passwords', {
      method: 'POST',
      body: JSON.stringify({ passwords, generate }),
    }, 'admin');
  },

  deleteAdminPassword(id) {
    return apiRequest(`/api/admin/passwords/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'admin');
  },

  getAdminLeaderboard() {
    return apiRequest('/api/admin/leaderboard', {}, 'admin');
  },

  getAdminLogs(limit = 100) {
    return apiRequest(`/api/admin/logs?limit=${encodeURIComponent(limit)}`, {}, 'admin');
  },

  getAdminKeyBlocker() {
    return apiRequest('/api/admin/keyblocker', {}, 'admin');
  },

  setAdminKeyBlocker(locked) {
    return apiRequest('/api/admin/keyblocker', {
      method: 'POST',
      body: JSON.stringify({ locked }),
    }, 'admin');
  },

  getAdminTeamActivity() {
    return apiRequest('/api/admin/team-activity', {}, 'admin');
  },

  getAdminTeamTimeline(teamId, limit = 500) {
    return apiRequest(
      `/api/admin/team-activity/${encodeURIComponent(teamId)}?limit=${encodeURIComponent(limit)}`, {}, 'admin',
    );
  },

  // The CSV needs the Authorization header, so it is fetched and saved as a blob.
  async downloadLeaderboardCsv() {
    const token = adminToken();
    const res = await fetch(`${API_BASE}/api/admin/export-csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      setAdminToken('');
      window.dispatchEvent(new CustomEvent(ADMIN_INVALID_EVENT));
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || `Export failed (HTTP ${res.status}).`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chronos_leaderboard_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },
};

export default api;
