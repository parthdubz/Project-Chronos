"""
Round 2: CHRONOS terminal investigation (Round 2 Backend PRD).

The backend is the source of truth. The frontend only renders what these
functions return. Everything below is decided here, never in the browser:

  * evidence access        (case files, is_locked, team must have started Round 2)
  * AI question limit      (max 3 per team)
  * AI point deductions    (5 / 5 / 10, from a 20 point AI budget)
  * culprit validation     (+30 correct, +0 wrong, one submission per team)
  * the Round 2 score      (culprit points + AI points kept, max 50)
  * the Round 2 timer

Tables used: round2_cases / round2_case_files / round2_case_suspects /
round2_team_cases (the 24 cases, see round2_cases.py), round2_chat_messages and
round2_submissions. They are created on first use, so this module needs no
change to the shared schema file.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from ..database.connection import get_connection
from . import gemini_service, round2_cases

# --- rules from the PRD ----------------------------------------------------
MAX_AI_QUESTIONS = 3
AI_DEDUCTIONS = (5, 5, 10)            # question 1, 2, 3
AI_BUDGET = sum(AI_DEDUCTIONS)        # 20 points, 0 left after question 3
CULPRIT_POINTS = 30
MAX_ROUND2_SCORE = CULPRIT_POINTS + AI_BUDGET  # 50

# The PRD does not give a Round 2 duration. 20 minutes is a placeholder until
# the final event specification exists; override with ROUND2_DURATION_SECONDS.
DURATION_SECONDS = int(os.environ.get("ROUND2_DURATION_SECONDS", "1200"))

ACTIVE_STATE = "ROUND_2_ACTIVE"
COMPLETED_STATE = "ROUND_2_COMPLETED"
TIMEOUT_STATE = "TIMEOUT"

# The shared project is not consistent about state spelling (Round 1 writes
# ROUND1_COMPLETED, PROJECT_REFERENCE.md says ROUND_1_COMPLETED), so states are
# compared with underscores removed.
STARTABLE = {"ROUND1COMPLETED", "ROUND2LOCKED"}


def _norm(state) -> str:
    return (state or "").replace("_", "").upper()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat(timespec="seconds")


def _parse(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace(" ", "T"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _seconds_left(started_at: str) -> int:
    deadline = _parse(started_at) + timedelta(seconds=DURATION_SECONDS)
    return max(0, int((deadline - _now()).total_seconds()))


# --- tables ------------------------------------------------------------------

def ensure_tables(connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS round2_chat_messages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id          TEXT NOT NULL,
            question_number  INTEGER NOT NULL,
            user_prompt      TEXT NOT NULL,
            ai_response      TEXT NOT NULL DEFAULT '',
            points_deducted  INTEGER NOT NULL,
            created_at       TEXT NOT NULL,
            UNIQUE (team_id, question_number)
        );

        CREATE TABLE IF NOT EXISTS round2_submissions (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id              TEXT NOT NULL UNIQUE,
            suspect              TEXT NOT NULL,
            is_correct           INTEGER NOT NULL,
            points_awarded       INTEGER NOT NULL,
            ai_points_remaining  INTEGER NOT NULL,
            round2_score         INTEGER NOT NULL,
            submitted_at         TEXT NOT NULL
        );
        """
    )

    # The 24 cases: create their tables and load the case folders (no-op once loaded).
    round2_cases.ensure_case_tables(connection)
    round2_cases.seed_cases(connection)
    connection.commit()


_ready = set()   # database files whose Round 2 tables were already checked by this process


def _db_key(connection) -> str:
    return str(connection.execute("PRAGMA database_list").fetchone()[2])


def _prepare(connection) -> None:
    key = _db_key(connection)
    if key not in _ready:
        ensure_tables(connection)
        _ready.add(key)


def init_round2() -> None:
    """Server start-up: create the Round 2 tables, load the 24 cases, and give a
    case to every team that does not have one yet (teams created before Round 2
    was installed). New teams get theirs when they register (auth_service)."""
    connection = get_connection()
    try:
        _prepare(connection)
        missing = connection.execute(
            "SELECT id FROM teams WHERE id NOT IN (SELECT team_id FROM round2_team_cases)"
        ).fetchall()
        for row in missing:
            round2_cases.assign_case(connection, row["id"])
        connection.commit()
    finally:
        connection.close()


class _Db:
    """Connection with the Round 2 tables guaranteed to exist."""

    def __enter__(self):
        self.connection = get_connection()
        try:
            _prepare(self.connection)
        except Exception:
            self.connection.close()
            raise
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.connection.commit()
        else:
            self.connection.rollback()
        self.connection.close()


def _log(connection, team_id, event_type, data) -> None:
    connection.execute(
        "INSERT INTO game_logs (team_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)",
        (team_id, event_type, json.dumps(data), _now_iso()),
    )


def _team(connection, team_id):
    row = connection.execute("SELECT * FROM teams WHERE id = ?", (str(team_id).strip(),)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Team not found.")
    return row


def _require_started(connection, team_id):
    team = _team(connection, team_id)
    if not team["round2_started_at"]:
        raise HTTPException(status_code=409, detail="Round 2 has not started for this team.")
    return team


def _case(connection, team):
    """The team's case. Normally assigned in start_round2; a team that started
    before cases existed gets one the first time it is needed."""
    return round2_cases.assign_case(connection, team["id"])


def _require_open(connection, team_id):
    """Team is inside Round 2, inside its deadline, and has not submitted yet."""
    team = _require_started(connection, team_id)
    state = _norm(team["current_state"])

    if state == _norm(COMPLETED_STATE):
        raise HTTPException(status_code=409, detail="Round 2 is already complete for this team.")
    if state == _norm(TIMEOUT_STATE):
        raise HTTPException(status_code=403, detail="Round 2 time has expired.")

    if _seconds_left(team["round2_started_at"]) <= 0:
        connection.execute(
            "UPDATE teams SET current_state = ?, updated_at = ? WHERE id = ?",
            (TIMEOUT_STATE, _now_iso(), team["id"]),
        )
        _log(connection, team["id"], "TIMEOUT", {"round": 2})
        connection.commit()  # keep the timeout even though we raise next
        raise HTTPException(status_code=403, detail="Round 2 time has expired.")

    return team


# --- progress ----------------------------------------------------------------

WELCOME = (
    "CHRONOS Analyst online. I can summarise the three evidence files, cross-reference "
    "them and point out contradictions. I will not name a culprit: that decision is yours. "
    "You may ask 3 questions (costs 5, 5 and 10 points)."
)


def _progress(connection, team) -> dict:
    tid = str(team["id"])
    rows = connection.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(points_deducted), 0) AS lost "
        "FROM round2_chat_messages WHERE team_id = ?",
        (tid,),
    ).fetchone()
    used, lost = rows["n"], rows["lost"]
    sub = connection.execute("SELECT * FROM round2_submissions WHERE team_id = ?", (tid,)).fetchone()
    started = team["round2_started_at"]

    return {
        "team_id": team["id"],
        "team_name": team["team_name"],
        "state": team["current_state"],
        "ai": {
            "max_questions": MAX_AI_QUESTIONS,
            "used": used,
            "remaining": MAX_AI_QUESTIONS - used,
            "points_remaining": AI_BUDGET - lost,
            "next_cost": AI_DEDUCTIONS[used] if used < MAX_AI_QUESTIONS else 0,
            "deductions": list(AI_DEDUCTIONS),
        },
        # Players never see whether they were right or what they scored. The score
        # is stored in the database for the admin leaderboard only; no player
        # endpoint returns it.
        "submitted": sub is not None,
        "suspect": None if sub is None else sub["suspect"],
        "seconds_left": _seconds_left(started) if started else None,
        "deadline": (_parse(started) + timedelta(seconds=DURATION_SECONDS)).isoformat(timespec="seconds")
                    if started else None,
        "welcome": WELCOME,
    }


def start_round2(team_id):
    with _Db() as connection:
        team = _team(connection, team_id)
        state = _norm(team["current_state"])

        # Refresh / re-entry never restarts the timer.
        if team["round2_started_at"] or state in {_norm(ACTIVE_STATE), _norm(COMPLETED_STATE), _norm(TIMEOUT_STATE)}:
            return _progress(connection, team)

        if state not in STARTABLE:
            raise HTTPException(
                status_code=409,
                detail=f"Round 2 cannot start from state {team['current_state']}.",
            )

        # Every new game gets a case this team has not played before.
        case = round2_cases.assign_case(connection, team["id"])

        connection.execute(
            "UPDATE teams SET current_state = ?, round2_started_at = ?, updated_at = ? WHERE id = ?",
            (ACTIVE_STATE, _now_iso(), _now_iso(), team["id"]),
        )
        _log(connection, team["id"], "ROUND_STARTED", {"round": 2, "case": case["case_id"]})
        return _progress(connection, _team(connection, team["id"]))


def get_progress(team_id):
    with _Db() as connection:
        return _progress(connection, _require_started(connection, team_id))


# --- evidence ----------------------------------------------------------------

def _redact(name: str) -> str:
    return "".join("█" if i % 3 == 2 else c for i, c in enumerate(name))


def list_files(team_id):
    """Metadata only. Locked files appear as locked, with no real name or content."""
    with _Db() as connection:
        team = _require_started(connection, team_id)
        rows = round2_cases.case_files(connection, _case(connection, team)["case_id"])

    files = []
    for n, row in enumerate(rows, start=1):
        locked = bool(row["is_locked"])
        files.append({
            "file_id": f"LOCKED_{n}" if locked else row["file_id"],
            "project_name": round2_cases.project_name(row["file_id"]),
            "timeline_tag": row["timeline_tag"],
            "filename": _redact(row["filename"]) if locked else row["filename"],
            "is_locked": locked,
        })
    return files


def read_file(team_id, file_id):
    with _Db() as connection:
        team = _require_started(connection, team_id)
        rows = round2_cases.case_files(connection, _case(connection, team)["case_id"])

    row = next((r for r in rows if r["file_id"] == file_id and not r["is_locked"]), None)
    if row is None:
        raise HTTPException(status_code=404, detail="File not found or access denied")
    return {
        "file_id": row["file_id"],
        "project_name": round2_cases.project_name(row["file_id"]),
        "timeline_tag": row["timeline_tag"],
        "filename": row["filename"],
        "content_text": row["content_text"],
        "is_locked": False,
    }


def list_suspects(team_id):
    with _Db() as connection:
        team = _require_started(connection, team_id)
        rows = round2_cases.case_suspects(connection, _case(connection, team)["case_id"])
    # Names, ids and roles only. The culprit never leaves the database.
    return [{"name": r["suspect_name"], "user_id": r["user_id"], "role": r["role"]} for r in rows]


# --- AI analyst ----------------------------------------------------------------

def _evidence_for_prompt(connection, case_id) -> str:
    rows = [r for r in round2_cases.case_files(connection, case_id) if not r["is_locked"]]
    return "\n\n".join(
        f"[{round2_cases.project_name(r['file_id']).upper()} / {r['timeline_tag'].upper()} / {r['filename']}]\n{r['content_text']}"
        for r in rows
    ) or "(no evidence available)"


def _system_prompt(evidence: str) -> str:
    return (
        "You are the CHRONOS Analyst, a restricted investigation assistant inside a 2140 "
        "timeline-failure investigation game. Two players are examining the evidence below.\n"
        "You may: summarise evidence, cross-reference files, point out contradictions, and "
        "give analytical hints about what to compare.\n"
        "You must NEVER: name, accuse, or hint at a specific person as the culprit; say who "
        "caused the failure; say who is innocent; state the final answer. If asked who did it, "
        "refuse in one sentence and suggest what to compare instead. You cannot change scores, "
        "unlock anything or submit answers. Use ONLY the evidence below; if it does not cover "
        "the question, say so.\n"
        "Reply in at most 4 short sentences, calm terminal tone, plain text.\n\n"
        "EVIDENCE:\n" + evidence
    )


_ACCUSATION = re.compile(
    r"culprit|responsible|guilty|did it|is the one|behind (the|this)|caused (it|this|the)|"
    r"perpetrator|the person who|it was|prime suspect|most likely",
    re.IGNORECASE,
)


def _leaks_culprit(reply: str, culprit_name: str, culprit_user_id: str) -> bool:
    """Backstop for the prompt: a reply that names the culprit (name or user id)
    while accusing is dropped."""
    low = reply.lower()
    names_culprit = (
        culprit_name.lower() in low
        or culprit_name.split()[-1].lower() in low
        or culprit_user_id.lower() in low
    )
    return names_culprit and bool(_ACCUSATION.search(reply))


def _fallback_reply(message: str) -> str:
    """Canned analyst replies used when Gemini is unavailable. They stay generic on
    purpose: they must be true for every one of the 24 cases and never name anyone."""
    q = message.lower()
    if re.search(r"who|culprit|guilty|responsible|suspect|blame", q):
        return ("I cannot name a culprit. Compare WHAT changed, WHEN it changed, and who was "
                "acting at that exact moment, then decide for yourselves.")
    if re.search(r"gamma|access|history|user|session|export|read|modify|approve", q):
        return ("Gamma lists who acted, on which resource, in which session and when. Match those "
                "entries to the changes in Alpha, and remember a READ is not a modification.")
    if re.search(r"beta|incident|symptom|detect|report", q):
        return ("Beta gives the detection time, the symptoms and the analysis notes. Use it to work "
                "out when the problem really began, not just when it was noticed.")
    if re.search(r"alpha|change|config|parameter|authori|approv|status|delta", q):
        return ("Alpha records the configuration changes and their status. An approved change is not "
                "automatically harmless, and a pending or reverted one may still matter.")
    if re.search(r"time|when|:\d\d|before|after|order", q):
        return ("Line the timestamps up: when each change was made, when the first symptom appeared, "
                "and who was active in Gamma at those moments. Order matters.")
    return ("Cross-reference the three files: what changed (Alpha), what was observed and when "
            "(Beta), and who acted at that moment (Gamma).")


def chat(team_id, message):
    message = (message or "").strip()[:300]
    if not message:
        raise HTTPException(status_code=400, detail="Message is empty.")

    # 1. Reserve the question slot BEFORE calling the AI. The limit, the point
    #    deduction and the recorded row are all fixed here, server-side. The
    #    UNIQUE (team_id, question_number) constraint makes two simultaneous
    #    questions from one team safe.
    with _Db() as connection:
        team = _require_open(connection, team_id)
        tid = str(team["id"])
        used = connection.execute(
            "SELECT COUNT(*) FROM round2_chat_messages WHERE team_id = ?", (tid,)
        ).fetchone()[0]

        if used >= MAX_AI_QUESTIONS:
            raise HTTPException(status_code=403, detail="No AI questions remaining.")

        number = used + 1
        deduction = AI_DEDUCTIONS[used]
        try:
            connection.execute(
                "INSERT INTO round2_chat_messages "
                "(team_id, question_number, user_prompt, ai_response, points_deducted, created_at) "
                "VALUES (?, ?, ?, '', ?, ?)",
                (tid, number, message, deduction, _now_iso()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Another question is already being processed.")

        history_rows = connection.execute(
            "SELECT user_prompt, ai_response FROM round2_chat_messages "
            "WHERE team_id = ? AND question_number < ? ORDER BY question_number",
            (tid, number),
        ).fetchall()
        history = []
        for r in history_rows:
            history.append({"role": "user", "text": r["user_prompt"]})
            history.append({"role": "assistant", "text": r["ai_response"]})
        case = _case(connection, team)
        evidence = _evidence_for_prompt(connection, case["case_id"])
        culprit_name = case["culprit"]
        culprit_user_id = next(
            (r["user_id"] for r in round2_cases.case_suspects(connection, case["case_id"])
             if r["suspect_name"].lower() == culprit_name.lower()), "")
        _log(connection, team["id"], "HINT_USED", {"round": 2, "question": number, "points_deducted": deduction})

    # 2. Ask Gemini outside the transaction so a slow API never holds a DB lock.
    reply = gemini_service.ask(_system_prompt(evidence), history, message)
    source = "gemini"
    if not reply or _leaks_culprit(reply, culprit_name, culprit_user_id):
        reply, source = _fallback_reply(message), "fallback"

    # 3. Store the answer on the reserved row.
    with _Db() as connection:
        connection.execute(
            "UPDATE round2_chat_messages SET ai_response = ? WHERE team_id = ? AND question_number = ?",
            (reply, tid, number),
        )
        progress = _progress(connection, _team(connection, tid))

    return {
        "reply": reply,
        "source": source,
        "question_number": number,
        "points_deducted": deduction,
        "progress": progress,
    }


def get_conversation(team_id):
    with _Db() as connection:
        team = _require_started(connection, team_id)
        rows = connection.execute(
            "SELECT question_number, user_prompt, ai_response, points_deducted "
            "FROM round2_chat_messages WHERE team_id = ? ORDER BY question_number",
            (str(team["id"]),),
        ).fetchall()
    return [dict(r) for r in rows]


# --- culprit submission ----------------------------------------------------------

def _match_suspect(connection, case_id, value: str):
    v = (value or "").strip().lower()
    return next(
        ({"name": r["suspect_name"], "user_id": r["user_id"]}
         for r in round2_cases.case_suspects(connection, case_id)
         if v in (r["user_id"].lower(), r["suspect_name"].lower())),
        None,
    )


def submit_culprit(team_id, suspect_value):
    with _Db() as connection:
        team = _require_started(connection, team_id)
        tid = str(team["id"])
        case = _case(connection, team)

        # Only this case's four candidates are valid answers.
        suspect = _match_suspect(connection, case["case_id"], suspect_value)
        if suspect is None:
            raise HTTPException(status_code=400, detail="Unknown suspect.")

        existing = connection.execute("SELECT 1 FROM round2_submissions WHERE team_id = ?", (tid,)).fetchone()
        if existing:  # a duplicate submission never awards points twice
            return _submit_response(_progress(connection, team), duplicate=True)

        team = _require_open(connection, team_id)

        used_lost = connection.execute(
            "SELECT COALESCE(SUM(points_deducted), 0) FROM round2_chat_messages WHERE team_id = ?", (tid,)
        ).fetchone()[0]
        ai_points_remaining = AI_BUDGET - used_lost

        correct = suspect["name"].strip().lower() == case["culprit"].strip().lower()
        points = CULPRIT_POINTS if correct else 0
        round2_score = points + ai_points_remaining

        try:
            connection.execute(
                "INSERT INTO round2_submissions "
                "(team_id, suspect, is_correct, points_awarded, ai_points_remaining, round2_score, submitted_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (tid, suspect["name"], int(correct), points, ai_points_remaining, round2_score, _now_iso()),
            )
        except sqlite3.IntegrityError:
            return _submit_response(_progress(connection, _team(connection, tid)), duplicate=True)

        now = _now_iso()
        connection.execute(
            "UPDATE teams SET round2_score = ?, "
            "total_score = COALESCE(round1_score, 0) + ? + COALESCE(round3_score, 0), "
            "current_state = ?, round2_completed_at = ?, updated_at = ? WHERE id = ?",
            (round2_score, round2_score, COMPLETED_STATE, now, now, team["id"]),
        )
        _log(connection, team["id"], "ANSWER_SUBMITTED",
             {"round": 2, "case": case["case_id"], "suspect": suspect["name"], "correct": correct})
        if correct:
            _log(connection, team["id"], "OMEGA_DISCOVERED", {"round": 2})
        _log(connection, team["id"], "ROUND_COMPLETED", {"round": 2, "score": round2_score})

        return _submit_response(_progress(connection, _team(connection, tid)), duplicate=False)


def _submit_response(progress: dict, duplicate: bool) -> dict:
    # Deliberately no correctness, points or score: players are not told how
    # they did. Those values live in round2_submissions / teams for the admin.
    return {
        "submitted": True,
        "duplicate": duplicate,
        "progress": progress,
    }
