"""
Admin access and the leaderboard data.

Admin access
  * CHRONOS_ADMIN_PASSWORD must be set (environment or .env). With no password the
    admin API is disabled; there is no built-in default.
  * Login returns a signed, expiring bearer token (HMAC-SHA256). Every /api/admin
    route except /login requires it.

Leaderboard data
  * Read-only: it only SELECTs, so opening or polling the leaderboard never changes
    any score or state.
  * It reports only what the database actually recorded. A round with no recorded
    result is None (shown as "-"), never 0. The total adds up the recorded rounds and
    says whether all three are present (total_complete).
  * Round 2 is investigation-only. Its only scoring rule is the AI-question
    deduction (EVENT_SPECIFICATIONS.md: start with 20, questions cost 5, 5, 10). The
    score is read from the recorded deductions (round2_chat_messages.points_deducted)
    for a team that has started Round 2, and stays None for a team that has not. While
    Round 2 is still running the value is flagged round2_provisional. A score recorded
    by an earlier build's culprit submission is used as recorded.
  * Ranking: total score, then total time (Round 1 start to Round 3 finish - only
    set once Round 3 is done), then earlier Round 3 completion, then earlier Round 2
    completion, then earlier Round 1 completion.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Header, HTTPException, Request

from ..config import setting
from ..database.connection import get_connection
from .round2_service import AI_BUDGET

TOKEN_TTL_SECONDS = 8 * 60 * 60
_FAILURE_WINDOW = 10 * 60
_FAILURE_LIMIT = 8
_failures: dict[str, list[float]] = {}


# --- authentication --------------------------------------------------------------

def _password() -> str:
    return setting("CHRONOS_ADMIN_PASSWORD")


def _signing_key() -> bytes:
    secret = setting("CHRONOS_ADMIN_SECRET")
    if not secret:
        # Derived from the password, so tokens stay valid across restarts and workers
        # without a second secret to manage.
        secret = "chronos-admin-token:" + _password()
    return hashlib.sha256(secret.encode()).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def admin_enabled() -> bool:
    return bool(_password())


def password_matches(candidate: str) -> bool:
    expected = _password()
    if not expected or not isinstance(candidate, str):
        return False
    return hmac.compare_digest(expected.encode(), candidate.encode())


def make_token(role: str = "master") -> str:
    payload = _b64(json.dumps(
        {"sub": "admin", "role": role, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    ).encode())
    signature = _b64(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def token_role(token: str) -> Optional[str]:
    """'master' | 'temp' for a valid, unexpired token, else None."""
    if not admin_enabled() or not token or "." not in token:
        return None
    payload, _, signature = token.partition(".")
    expected = _b64(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        data = json.loads(_unb64(payload))
        if data.get("sub") == "admin" and int(data.get("exp", 0)) > time.time():
            return "temp" if data.get("role") == "temp" else "master"
    except Exception:
        pass
    return None


def token_valid(token: str) -> bool:
    return token_role(token) is not None


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_login_allowed(request: Request) -> None:
    now = time.time()
    key = _client_key(request)
    recent = [t for t in _failures.get(key, []) if now - t < _FAILURE_WINDOW]
    _failures[key] = recent
    if len(recent) >= _FAILURE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")


def record_login_failure(request: Request) -> None:
    _failures.setdefault(_client_key(request), []).append(time.time())


def require_admin(authorization: str = Header(default="")) -> str:
    """FastAPI dependency for every protected /api/admin route. Returns the role."""
    if not admin_enabled():
        raise HTTPException(status_code=503, detail="Admin access is not configured on this server.")
    scheme, _, token = authorization.partition(" ")
    role = token_role(token.strip()) if scheme.lower() == "bearer" else None
    if role is None:
        raise HTTPException(status_code=401, detail="Admin authentication required.")
    return role


def require_master(authorization: str = Header(default="")) -> str:
    """Password control is for the master password only (a one-time login cannot mint more)."""
    role = require_admin(authorization)
    if role != "master":
        raise HTTPException(status_code=403, detail="Only the master password can manage access passwords.")
    return role


# --- access passwords (master + one-time temporary passwords) ------------------------
#
# The master password (CHRONOS_ADMIN_PASSWORD) never expires. Temporary passwords are added
# by the master, work exactly once, and are then listed as "used". Nothing here touches
# teams, scores or the leaderboard data.

_PW_MIN, _PW_MAX, _PW_BATCH = 4, 64, 100
_PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def _pw_table(connection) -> None:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS admin_passwords ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, password TEXT NOT NULL UNIQUE, "
        "created_at TEXT NOT NULL, used_at TEXT, used_from TEXT)"
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def authenticate(candidate: str, client: str) -> Optional[str]:
    """'master' for the master password, 'temp' when a one-time password was just consumed,
    None otherwise. The consume is a single conditional UPDATE, so two simultaneous logins
    with the same temporary password can never both succeed."""
    if password_matches(candidate):
        return "master"
    if not isinstance(candidate, str) or not candidate:
        return None
    connection = get_connection()
    try:
        _pw_table(connection)
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute(
            "UPDATE admin_passwords SET used_at = ?, used_from = ? WHERE password = ? AND used_at IS NULL",
            (_now_iso(), client, candidate),
        )
        connection.commit()
        return "temp" if cursor.rowcount == 1 else None
    finally:
        connection.close()


def _pw_row(r) -> dict[str, Any]:
    return {
        "id": r["id"], "password": r["password"], "created_at": r["created_at"],
        "used_at": r["used_at"], "used_from": r["used_from"],
    }


def list_passwords() -> dict[str, Any]:
    connection = get_connection()
    try:
        _pw_table(connection)
        rows = connection.execute("SELECT * FROM admin_passwords ORDER BY id").fetchall()
        return {
            "unused": [_pw_row(r) for r in rows if r["used_at"] is None],
            "used": [_pw_row(r) for r in sorted(rows, key=lambda r: r["used_at"] or "", reverse=True)
                     if r["used_at"] is not None],
        }
    finally:
        connection.close()


def add_passwords(passwords: list[str], generate: int = 0) -> dict[str, Any]:
    """Add several temporary passwords at once (typed ones and/or `generate` random ones)."""
    wanted = [(p or "").strip() for p in passwords or []]
    wanted += ["".join(secrets.choice(_PW_ALPHABET) for _ in range(8)) for _ in range(max(0, generate))]
    if not wanted:
        raise HTTPException(status_code=400, detail="Give at least one password, or a number to generate.")
    if len(wanted) > _PW_BATCH:
        raise HTTPException(status_code=400, detail=f"At most {_PW_BATCH} passwords per request.")

    master = _password()
    added: list[str] = []
    skipped: list[dict[str, str]] = []
    connection = get_connection()
    try:
        _pw_table(connection)
        connection.execute("BEGIN IMMEDIATE")
        seen: set[str] = set()
        for pw in wanted:
            if not pw:
                continue
            if len(pw) < _PW_MIN or len(pw) > _PW_MAX:
                skipped.append({"password": pw, "reason": f"must be {_PW_MIN}-{_PW_MAX} characters"})
            elif pw == master:
                skipped.append({"password": pw, "reason": "is the master password"})
            elif pw in seen:
                skipped.append({"password": pw, "reason": "listed twice"})
            else:
                seen.add(pw)
                try:
                    connection.execute(
                        "INSERT INTO admin_passwords (password, created_at) VALUES (?, ?)", (pw, _now_iso())
                    )
                    added.append(pw)
                except sqlite3.IntegrityError:
                    skipped.append({"password": pw, "reason": "already exists (unused or used)"})
        connection.commit()
    finally:
        connection.close()
    return {"added": added, "skipped": skipped}


def delete_unused_password(password_id: int) -> bool:
    connection = get_connection()
    try:
        _pw_table(connection)
        cursor = connection.execute(
            "DELETE FROM admin_passwords WHERE id = ? AND used_at IS NULL", (password_id,)
        )
        connection.commit()
        return cursor.rowcount == 1
    finally:
        connection.close()


# --- leaderboard -----------------------------------------------------------------

def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip().replace(" ", "T"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _team_ids(connection, sql: str) -> set[int]:
    try:
        return {int(r[0]) for r in connection.execute(sql).fetchall()}
    except (sqlite3.OperationalError, ValueError, TypeError):
        return set()  # table not created yet


def _fmt_seconds(seconds: Optional[float]) -> str:
    if seconds is None:
        return "--:--"
    s = int(seconds)
    return f"{s // 60:02d}:{s % 60:02d}"


_AFTER_ROUND2 = {
    "ROUND2COMPLETED", "TIMEOUT", "ROUND3ACTIVE", "DECISIONSUBMITTED", "FINALREVEAL", "COMPLETED",
}


def _state_label(state: str) -> str:
    key = (state or "").replace("_", "").upper()
    if key in {"COMPLETED", "DECISIONSUBMITTED", "FINALREVEAL"}:
        return "FINISHED"
    return state or "READY"


def leaderboard() -> list[dict[str, Any]]:
    connection = get_connection()
    try:
        teams = connection.execute("SELECT * FROM teams ORDER BY id").fetchall()
        r1_recorded_ids = _team_ids(connection, "SELECT DISTINCT team_id FROM round1_submissions")
        r2_recorded_ids = _team_ids(connection, "SELECT DISTINCT team_id FROM round2_submissions")
        r3_recorded_ids = _team_ids(connection, "SELECT DISTINCT team_id FROM round3_submissions")
        ledger: dict[int, tuple[int, float]] = {}
        try:
            for row in connection.execute(
                "SELECT team_id, COUNT(*) AS n, COALESCE(SUM(points_deducted), 0) AS lost "
                "FROM round2_chat_messages GROUP BY team_id"
            ).fetchall():
                ledger[int(row["team_id"])] = (int(row["n"]), float(row["lost"]))
        except (sqlite3.OperationalError, ValueError, TypeError):
            pass  # Round 2 tables not created yet

        # which Round 2 case each team played
        r2_case: dict[int, str] = {}
        try:
            for row in connection.execute("SELECT team_id, case_id FROM round2_team_cases").fetchall():
                r2_case[int(row["team_id"])] = row["case_id"]
        except (sqlite3.OperationalError, ValueError, TypeError):
            pass

        # was the live AI API used for this team's questions? (n answered, n by canned fallback)
        ai_use: dict[int, tuple[int, int, int]] = {}
        try:
            for row in connection.execute(
                "SELECT team_id, "
                "SUM(CASE WHEN ai_source IS NOT NULL AND ai_source != '' AND ai_source != 'fallback' THEN 1 ELSE 0 END) AS live, "
                "SUM(CASE WHEN ai_source = 'fallback' THEN 1 ELSE 0 END) AS fallback, "
                "SUM(CASE WHEN ai_response != '' AND (ai_source IS NULL OR ai_source = '') THEN 1 ELSE 0 END) AS unknown "
                "FROM round2_chat_messages GROUP BY team_id"
            ).fetchall():
                ai_use[int(row["team_id"])] = (
                    int(row["live"] or 0), int(row["fallback"] or 0), int(row["unknown"] or 0),
                )
        except (sqlite3.OperationalError, ValueError, TypeError):
            pass  # table or column not there yet
    finally:
        connection.close()

    entries: list[dict[str, Any]] = []
    for t in teams:
        tid = t["id"]
        r1_done = _parse_ts(t["round1_completed_at"])
        r1_start = _parse_ts(t["round1_started_at"])
        r2_done = _parse_ts(t["round2_completed_at"])
        r3_done = _parse_ts(t["round3_completed_at"])

        r1 = float(t["round1_score"] or 0) if (tid in r1_recorded_ids or r1_done) else None

        questions, lost = ledger.get(tid, (0, 0.0))
        state_key = (t["current_state"] or "").replace("_", "").upper()
        r2_over = bool(r2_done) or state_key in _AFTER_ROUND2
        r2_source = None
        if tid in r2_recorded_ids:                      # legacy culprit-submission score, as recorded
            r2, r2_source = float(t["round2_score"] or 0), "legacy_submission"
        elif t["round2_started_at"]:                    # investigation-only: 20 minus recorded deductions
            r2, r2_source = float(AI_BUDGET) - lost, "ai_deductions"
        else:
            r2 = None
        r3 = float(t["round3_score"] or 0) if tid in r3_recorded_ids else None
        # Transition Round (20 points, between Round 1 and Round 2): counted in the total only.
        transition = float(t["transition_score"] or 0) if t["transition_completed_at"] else None
        core = [v for v in (r1, r2, r3) if v is not None]
        recorded = [v for v in (r1, transition, r2, r3) if v is not None]
        r1_seconds = (r1_done - r1_start).total_seconds() if (r1_done and r1_start) else None
        # Total time: Round 1 start to Round 3 finish (wall-clock, includes any waits between
        # rounds). Only set once a team has actually finished Round 3 - an in-progress team's
        # partial elapsed time is not comparable to a finished team's total.
        total_time_seconds = (r3_done - r1_start).total_seconds() if (r3_done and r1_start) else None

        # transition zone (from the clue the team was given)
        zone = ""
        clue_id = t["transition_clue_id"] if "transition_clue_id" in t.keys() else None
        if clue_id is not None:
            try:
                from .transition_service import zone_for_clue

                zone = zone_for_clue(int(clue_id)).upper()
            except (ValueError, TypeError, IndexError):
                zone = ""

        # AI API: "Yes" when every answered question came from the live API, "No" when at
        # least one had to use the built-in fallback, "" when no question was asked / unknown
        live_n, fallback_n, unknown_n = ai_use.get(tid, (0, 0, 0))
        if fallback_n:
            ai_api_live = "No"
        elif live_n:
            ai_api_live = "Yes"
        else:
            ai_api_live = ""

        entries.append({
            "team_id": tid,
            "team_name": t["team_name"],
            "member_1_name": t["member_1_name"] or "",
            "member_2_name": t["member_2_name"] or "",
            "member_1_prn": t["member_1_prn"] or "",
            "member_2_prn": t["member_2_prn"] or "",
            "round1_auth_code": t["round1_auth_code"] or "",
            "current_state": t["current_state"] or "READY",
            "status": _state_label(t["current_state"]),
            "round1_score": r1,
            "round2_score": r2,
            "round3_score": r3,
            "transition_score": transition,
            "round2_source": r2_source,
            "round2_provisional": r2 is not None and r2_source == "ai_deductions" and not r2_over,
            "round2_case": r2_case.get(tid, ""),
            "transition_zone": zone,
            "ai_api_live": ai_api_live,
            "round2_questions_used": questions if r2_source else None,
            "round2_points_deducted": lost if r2_source else None,
            "total_score": sum(recorded) if recorded else None,
            "total_complete": len(core) == 3,
            "recorded_rounds": [n for n, v in ((1, r1), (2, r2), (3, r3)) if v is not None],
            "r1_started_at": t["round1_started_at"],
            "r1_completed_at": t["round1_completed_at"],
            "r2_completed_at": t["round2_completed_at"],
            "r3_completed_at": t["round3_completed_at"],
            "r1_time_diff": r1_seconds,
            "r1_time_formatted": _fmt_seconds(r1_seconds),
            "total_time_seconds": total_time_seconds,
            "total_time_formatted": _fmt_seconds(total_time_seconds),
            "_k": (r3_done, r2_done, r1_done),
            "_total_time": total_time_seconds,
        })

    far = datetime.max.replace(tzinfo=timezone.utc)

    def sort_key(e):
        total = e["total_score"] if e["total_score"] is not None else float("-inf")
        total_time = e["_total_time"] if e["_total_time"] is not None else float("inf")
        r3d, r2d, r1d = e["_k"]
        return (-total, total_time, r3d or far, r2d or far, r1d or far, e["team_id"])

    entries.sort(key=sort_key)

    previous = None
    for index, entry in enumerate(entries):
        tie_key = sort_key(entry)[:-1]
        entry["rank"] = entries[index - 1]["rank"] if (previous == tie_key and index) else index + 1
        previous = tie_key
        del entry["_k"]
        del entry["_total_time"]
    return entries


def _csv_cell(value: Any) -> Any:
    """Neutralise spreadsheet formulas in user-supplied text."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def leaderboard_csv() -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Rank", "Team Name", "Member 1", "Member 1 PRN", "Member 2", "Member 2 PRN",
        "State", "Round 1 Score", "Round 1 Time", "Transition Zone", "Transition Score",
        "Round 2 Case", "Round 2 Score", "Round 3 Score",
        "Round 2 AI Questions Used", "AI API Live (Yes/No)",
        "Total (recorded rounds)", "All rounds recorded", "Round 3 Completed At",
    ])
    for t in leaderboard():
        writer.writerow([_csv_cell(v) for v in (
            t["rank"], t["team_name"], t["member_1_name"], t["member_1_prn"],
            t["member_2_name"], t["member_2_prn"], t["status"],
            "" if t["round1_score"] is None else t["round1_score"], t["r1_time_formatted"],
            t["transition_zone"],
            "" if t["transition_score"] is None else t["transition_score"],
            t["round2_case"],
            "" if t["round2_score"] is None else t["round2_score"],
            "" if t["round3_score"] is None else t["round3_score"],
            "" if t["round2_questions_used"] is None else t["round2_questions_used"],
            t["ai_api_live"],
            "" if t["total_score"] is None else t["total_score"],
            "yes" if t["total_complete"] else "no", t["r3_completed_at"] or "",
        )])
    return output.getvalue()


# Every table that holds rows for one team (the row itself is in `teams`).
_TEAM_TABLES = (
    "game_logs", "hints", "investments", "team_fragments", "submissions",
    "round1_submissions", "round1_team_items",
    "round2_chat_messages", "round2_submissions", "round2_team_cases", "round2_case_history",
    "round3_submissions", "round3_team_cases",
)


def delete_team(team_id: int) -> dict[str, Any]:
    """Permanently remove one team and everything recorded for it (host action, master admin).
    Case / item catalogues and other teams are not touched."""
    connection = get_connection()
    try:
        connection.execute("BEGIN IMMEDIATE")
        team = connection.execute("SELECT id, team_name FROM teams WHERE id = ?", (team_id,)).fetchone()
        if team is None:
            connection.rollback()
            raise HTTPException(status_code=404, detail="Team not found.")
        existing = {
            r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        removed = 0
        for table in _TEAM_TABLES:
            if table in existing:
                removed += connection.execute(f'DELETE FROM "{table}" WHERE team_id = ?', (team_id,)).rowcount
        connection.execute("DELETE FROM teams WHERE id = ?", (team_id,))
        if "game_logs" in existing:
            connection.execute(
                "INSERT INTO game_logs (team_id, event_type, event_data, created_at) VALUES (NULL, 'ADMIN_TEAM_DELETED', ?, ?)",
                (json.dumps({"team_id": team_id, "team_name": team["team_name"]}),
                 datetime.now(timezone.utc).isoformat()),
            )
        connection.commit()
        return {"deleted": True, "team_id": team_id, "team_name": team["team_name"], "rows_removed": removed}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def recent_logs(limit: int) -> list[dict[str, Any]]:
    connection = get_connection()
    try:
        rows = connection.execute(
            "SELECT l.id, l.team_id, t.team_name, l.event_type, l.event_data, l.created_at "
            "FROM game_logs l LEFT JOIN teams t ON l.team_id = t.id "
            "ORDER BY l.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        connection.close()


# ---------------------------------------------------------------- per-team activity feed
# Read-only. Merges game_logs with the richer per-action tables (Round 1 answers, Round 2 AI
# questions) into one readable timeline per team, so the host can see what a team is doing.

_ROUND_OF_EVENT = {
    "LOGIN": 0, "ROUND1_STARTED": 1, "ROUND1_COMPLETED": 1,
    "TRANSITION_CLUE_ASSIGNED": 1.5, "TRANSITION_STARTED": 1.5, "TRANSITION_STOPPED": 1.5,
    "TRANSITION_ATTEMPT": 1.5, "TRANSITION_COMPLETED": 1.5,
    "ROUND_STARTED": 2, "HINT_USED": 2, "ANSWER_SUBMITTED": 2, "OMEGA_DISCOVERED": 2,
    "ROUND_COMPLETED": 2, "TIMEOUT": 2, "R3_START": 3, "R3_SUBMIT": 3,
}


def _ts_key(value: Any) -> float:
    """Sortable epoch seconds from the mixed timestamp formats in the database."""
    if not value:
        return 0.0
    s = str(value).strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return 0.0
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def _iso(value: Any) -> Optional[str]:
    k = _ts_key(value)
    return datetime.fromtimestamp(k, timezone.utc).isoformat() if k else None


def _describe_event(event_type: str, data: dict[str, Any]) -> tuple[str, str, str]:
    """(title, detail, tone) for a game_logs row. tone: good | bad | info | warn."""
    t = event_type
    if t == "LOGIN":
        new = data.get("result") == "REGISTERED_NEW_TEAM"
        return ("Registered and logged in" if new else "Logged in again", "", "info")
    if t == "ROUND1_STARTED":
        return ("Started Round 1", f"{data.get('items', '')} items", "info")
    if t == "ROUND1_COMPLETED":
        via = data.get("via")
        detail = ""
        if data.get("submitted_items") is not None:
            detail = f"{data.get('submitted_items')}/{data.get('total_items')} items answered"
        return ("Finished Round 1" + (" (time up)" if via == "TIME_UP" else ""), detail,
                "warn" if via == "TIME_UP" else "good")
    if t == "TRANSITION_CLUE_ASSIGNED":
        return ("Transition clue assigned", f"clue #{data.get('clue_id')}", "info")
    if t == "TRANSITION_STARTED":
        return ("Transition stopwatch started", f"clue #{data.get('clue_id')}", "info")
    if t == "TRANSITION_STOPPED":
        ms = data.get("elapsed_ms")
        return ("Reached the physical location", f"{round(ms / 1000)}s on the stopwatch" if ms else "", "info")
    if t == "TRANSITION_ATTEMPT":
        ok = bool(data.get("correct"))
        delta = data.get("points_delta")
        return (f"Password attempt {data.get('attempt', '')} - " + ("correct" if ok else "wrong"),
                f"{delta:+g} pts" if isinstance(delta, (int, float)) else "",
                "good" if ok else "bad")
    if t == "TRANSITION_COMPLETED":
        ok = data.get("result") == "CORRECT"
        return ("Transition round " + ("passed" if ok else "locked out"), f"score {data.get('score')}",
                "good" if ok else "bad")
    if t == "ROUND_STARTED":
        return (f"Started Round {data.get('round', '')}", f"case {data.get('case', '')}", "info")
    if t == "HINT_USED":
        return (f"Asked AI question {data.get('question')}", f"-{data.get('points_deducted', 0)} pts", "warn")
    if t == "ANSWER_SUBMITTED":
        ok = bool(data.get("correct"))
        return (f"Named suspect: {data.get('suspect', '?')}", "correct" if ok else "wrong",
                "good" if ok else "bad")
    if t == "OMEGA_DISCOVERED":
        return ("Discovered OMEGA", "", "good")
    if t == "ROUND_COMPLETED":
        return (f"Finished Round {data.get('round', '')}",
                f"score {data['score']}" if "score" in data else "", "good")
    if t == "TIMEOUT":
        return (f"Round {data.get('round', '')} timed out", "", "bad")
    if t == "R3_START":
        return ("Started Round 3", f"case {data.get('case', '')}", "info")
    if t == "R3_SUBMIT":
        ok = bool(data.get("correct"))
        return (f"Final accusation: {data.get('candidate', '?')}",
                f"{data.get('evidence_count', 0)} evidence picked - " + ("correct" if ok else "wrong"),
                "good" if ok else "bad")
    if t == "ADMIN_KEYBLOCKER":
        return ("Host " + ("LOCKED" if data.get("locked") else "UNLOCKED") + " the keys on all laptops", "", "info")
    if t == "SECURITY_KEY_BLOCKED":
        return ("Pressed a blocked key", data.get("detail", ""), "warn")
    if t == "SECURITY_FOCUS_LOST":
        return ("Left the game window", data.get("detail", "") or "another window / tab was in front", "bad")
    if t == "SECURITY_LOCK_UNAVAILABLE":
        return ("Browser cannot lock the keyboard", "Alt+Tab / Ctrl+W / Win key are NOT blocked here", "bad")
    if t == "SECURITY_FULLSCREEN_EXIT":
        return ("Left fullscreen", "", "bad")
    if t in ("DEV_SKIP", "DEV_SKIP_SWITCH"):
        return ("Tester skip used" if t == "DEV_SKIP" else "Skip shortcut switched",
                f"skipped {data.get('skipped')}" if data.get("skipped") else "", "warn")
    return (t.replace("_", " ").capitalize(), "", "info")


def _event_data(raw: Any) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def team_activity_summary() -> list[dict[str, Any]]:
    """One row per team: where it is and what it did last."""
    connection = get_connection()
    try:
        teams = connection.execute(
            "SELECT id, team_name, current_state, updated_at FROM teams ORDER BY id"
        ).fetchall()
        logs = connection.execute(
            "SELECT team_id, event_type, event_data, created_at FROM game_logs "
            "WHERE team_id IS NOT NULL ORDER BY id"
        ).fetchall()
        last: dict[int, dict[str, Any]] = {}
        counts: dict[int, int] = {}
        for r in logs:
            tid = r["team_id"]
            counts[tid] = counts.get(tid, 0) + 1
            title, detail, tone = _describe_event(r["event_type"], _event_data(r["event_data"]))
            last[tid] = {"title": title, "detail": detail, "tone": tone, "at": _iso(r["created_at"])}
        out = []
        for t in teams:
            ev = last.get(t["id"])
            out.append({
                "team_id": t["id"],
                "team_name": t["team_name"],
                "current_state": t["current_state"],
                "events": counts.get(t["id"], 0),
                "last_event": ev,
                "last_seen": (ev or {}).get("at") or _iso(t["updated_at"]),
            })
        return out
    finally:
        connection.close()


def team_activity(team_id: int, limit: int = 500) -> dict[str, Any]:
    """Chronological timeline (oldest first) of everything one team did."""
    connection = get_connection()
    try:
        team = connection.execute(
            "SELECT id, team_name, current_state FROM teams WHERE id = ?", (team_id,)
        ).fetchone()
        if team is None:
            raise HTTPException(status_code=404, detail="Team not found.")
        existing = {
            r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        events: list[dict[str, Any]] = []

        if "game_logs" in existing:
            for r in connection.execute(
                "SELECT event_type, event_data, created_at FROM game_logs WHERE team_id = ?", (team_id,)
            ):
                if r["event_type"] == "HINT_USED" and "round2_chat_messages" in existing:
                    continue  # shown with the actual question below
                title, detail, tone = _describe_event(r["event_type"], _event_data(r["event_data"]))
                events.append({
                    "at": _iso(r["created_at"]), "k": _ts_key(r["created_at"]),
                    "round": _ROUND_OF_EVENT.get(r["event_type"], 0),
                    "type": r["event_type"], "title": title, "detail": detail, "tone": tone,
                })

        if "round1_submissions" in existing and "round1_items" in existing:
            for r in connection.execute(
                "SELECT s.selected_era, s.is_correct, s.points_awarded, s.submitted_at, i.item_name, i.correct_era "
                "FROM round1_submissions s LEFT JOIN round1_items i ON i.item_id = s.item_id "
                "WHERE s.team_id = ?", (team_id,)
            ):
                ok = bool(r["is_correct"])
                events.append({
                    "at": _iso(r["submitted_at"]), "k": _ts_key(r["submitted_at"]), "round": 1,
                    "type": "R1_ANSWER",
                    "title": f"{r['item_name'] or 'Item'} -> {r['selected_era']}",
                    "detail": ("correct" if ok else f"wrong (was {r['correct_era']})")
                              + f", {r['points_awarded']:+g} pts",
                    "tone": "good" if ok else "bad",
                })

        if "round2_chat_messages" in existing:
            for r in connection.execute(
                "SELECT question_number, user_prompt, ai_response, points_deducted, created_at "
                "FROM round2_chat_messages WHERE team_id = ?", (str(team_id),)
            ):
                reply = (r["ai_response"] or "").strip()
                shown = reply[:280] + ("..." if len(reply) > 280 else "")
                events.append({
                    "at": _iso(r["created_at"]), "k": _ts_key(r["created_at"]), "round": 2,
                    "type": "R2_QUESTION",
                    "title": f"AI question {r['question_number']}: {r['user_prompt']}",
                    "detail": (f"AI: {shown} " if shown else "") + f"(-{r['points_deducted']} pts)",
                    "tone": "warn",
                })

        events.sort(key=lambda e: e["k"])
        total = len(events)
        events = events[-limit:]
        for e in events:
            e.pop("k", None)
        return {
            "team_id": team["id"], "team_name": team["team_name"],
            "current_state": team["current_state"], "total": total, "events": events,
        }
    finally:
        connection.close()
