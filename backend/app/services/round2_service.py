"""
Round 2: CHRONOS terminal investigation (Round 2 Backend PRD).

The backend is the source of truth. The frontend only renders what these
functions return. Everything below is decided here, never in the browser:

  * evidence access        (case files, is_locked, team must have started Round 2)
  * AI question limit      (max 3 per team)
  * AI point deductions    (5 / 5 / 10, from a 20 point AI budget)
  * the end of the round   (POST /complete, or the clock; investigation-only,
                            no culprit submission and no score is needed to leave)
  * (legacy) culprit validation and Round 2 score: submit_culprit, no longer routed
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
from . import ai_service, round2_cases

# --- rules from the PRD ----------------------------------------------------
MAX_AI_QUESTIONS = 3
AI_DEDUCTIONS = (5, 5, 10)            # question 1, 2, 3
AI_BUDGET = sum(AI_DEDUCTIONS)        # 20 points, 0 left after question 3
CULPRIT_POINTS = 0                    # Round 2 awards no culprit points (investigation only)
MAX_ROUND2_SCORE = AI_BUDGET          # 20: the AI budget is the whole Round 2 score

# The PRD does not give a Round 2 duration. 20 minutes is a placeholder until
# the final event specification exists; override with ROUND2_DURATION_SECONDS.
DURATION_SECONDS = int(os.environ.get("ROUND2_DURATION_SECONDS", "1200"))

ACTIVE_STATE = "ROUND_2_ACTIVE"
# States a team can be in once its Round 2 has ended (it may return to the Round 2 lobby
# from Round 3, so a team that already moved on still reads as "Round 2 is over").
_ROUND2_OVER_STATES = {"ROUND2COMPLETED", "TIMEOUT", "ROUND3ACTIVE", "DECISIONSUBMITTED", "FINALREVEAL", "COMPLETED"}
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

    # request_id: the browser's id for one question, so a retried request is recognised.
    columns = {r["name"] for r in connection.execute("PRAGMA table_info(round2_chat_messages)")}
    if "request_id" not in columns:
        connection.execute("ALTER TABLE round2_chat_messages ADD COLUMN request_id TEXT")
    # ai_source: which AI provider answered ("groq", "gemini"), or "fallback" when the live API
    # could not (the CSV export shows whether the AI API was live for a team).
    if "ai_source" not in columns:
        connection.execute("ALTER TABLE round2_chat_messages ADD COLUMN ai_source TEXT")
    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_round2_chat_request "
        "ON round2_chat_messages(team_id, request_id) WHERE request_id IS NOT NULL"
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
        # The connection is ALWAYS closed, even when the commit itself fails (for example
        # "database is locked"). A connection left open would keep its write lock and
        # block every other request until the server is restarted.
        try:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
        except Exception:
            try:
                self.connection.rollback()
            except Exception:
                pass
            raise
        finally:
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


def _expire_if_due(connection, team):
    """Round 2 time is up but no request has noticed yet: record the timeout now
    (once), so the team is never left in ROUND_2_ACTIVE after the clock ran out.
    round2_completed_at is the moment the round closed (its deadline), not "now".
    Returns the up-to-date team row."""
    started = team["round2_started_at"]
    if (
        started
        and _norm(team["current_state"]) == _norm(ACTIVE_STATE)
        and _seconds_left(started) <= 0
    ):
        closed_at = (_parse(started) + timedelta(seconds=DURATION_SECONDS)).isoformat(timespec="seconds")
        connection.execute(
            "UPDATE teams SET current_state = ?, round2_completed_at = COALESCE(round2_completed_at, ?), "
            "updated_at = ? WHERE id = ?",
            (TIMEOUT_STATE, closed_at, _now_iso(), team["id"]),
        )
        _log(connection, team["id"], "TIMEOUT", {"round": 2})
        connection.commit()
        return _team(connection, team["id"])
    return team


def round2_is_over(team) -> bool:
    """True once this team's Round 2 has ended: completed, timed out, or the clock
    has run out (even if no request has recorded the timeout yet). Round 3 uses
    this as its entry gate; it reads the team row only and never needs a score."""
    if not team["round2_started_at"]:
        return False
    state = _norm(team["current_state"])
    if state in {_norm(COMPLETED_STATE), _norm(TIMEOUT_STATE)}:
        return True
    return state == _norm(ACTIVE_STATE) and _seconds_left(team["round2_started_at"]) <= 0


def _require_open(connection, team_id):
    """Team is inside Round 2 and inside its deadline."""
    team = _expire_if_due(connection, _require_started(connection, team_id))
    state = _norm(team["current_state"])

    if state == _norm(COMPLETED_STATE):
        raise HTTPException(status_code=409, detail="Round 2 is already complete for this team.")
    if state == _norm(TIMEOUT_STATE):
        raise HTTPException(status_code=403, detail="Round 2 time has expired.")

    return team


# --- scoring (isolated) -----------------------------------------------------
# EVENT_SPECIFICATIONS.md "CHATBOT LIMIT": a team starts with 20 AI investigation
# points; question 1 costs 5, question 2 costs 5, question 3 costs 10 (AI_DEDUCTIONS).
# The only Round 2 scoring rule is that deduction. Each charge is one row in
# round2_chat_messages (points_deducted), which is the ledger the admin leaderboard
# reads. Opening files, reloading, progress polls and completing the investigation
# never touch it.

def _sync_round2_score(connection, team_id) -> None:
    """Mirror the ledger into teams.round2_score (and total_score) so other readers
    of the teams row agree. Does nothing for a team that has a legacy culprit
    submission: that recorded score is left exactly as it was."""
    tid = str(team_id)
    legacy = connection.execute("SELECT 1 FROM round2_submissions WHERE team_id = ?", (tid,)).fetchone()
    if legacy:
        return
    lost = connection.execute(
        "SELECT COALESCE(SUM(points_deducted), 0) FROM round2_chat_messages WHERE team_id = ?", (tid,)
    ).fetchone()[0]
    score = AI_BUDGET - lost
    connection.execute(
        "UPDATE teams SET round2_score = ?, "
        "total_score = COALESCE(round1_score, 0) + COALESCE(transition_score, 0) + ? "
        "+ COALESCE(round3_score, 0) WHERE id = ?",
        (score, score, team_id),
    )


def _normalise_prompt(text: str) -> str:
    return " ".join((text or "").lower().split())


# --- progress ----------------------------------------------------------------

WELCOME = (
    "CHRONOS Analyst online. I can summarise the four evidence files, cross-reference "
    "them and point out contradictions. I will not name a responsible project: that decision "
    "is yours. You may ask 3 questions (costs 5, 5 and 10 points)."
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
        # Round 2 is investigation-only: the team ends it with /complete (or the
        # clock does). `completed` is true once it has ended either way.
        "completed": _norm(team["current_state"]) in _ROUND2_OVER_STATES or sub is not None,
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
            return _progress(connection, _expire_if_due(connection, team))

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
        _sync_round2_score(connection, team["id"])
        return _progress(connection, _team(connection, team["id"]))


def get_progress(team_id):
    with _Db() as connection:
        team = _expire_if_due(connection, _require_started(connection, team_id))
        return _progress(connection, team)


def complete_round2(team_id):
    """End the investigation (Round 2 has no culprit submission).

    Idempotent: calling it again, or after the clock ran out, never fails and never
    changes an already-recorded end. Scores are not touched here: nothing about
    scoring can keep a team inside Round 2.
    """
    with _Db() as connection:
        team = _expire_if_due(connection, _require_started(connection, team_id))
        state = _norm(team["current_state"])

        if state not in {_norm(COMPLETED_STATE), _norm(TIMEOUT_STATE)}:
            if state != _norm(ACTIVE_STATE):
                raise HTTPException(
                    status_code=409,
                    detail=f"Round 2 cannot be completed from state {team['current_state']}.",
                )
            now = _now_iso()
            connection.execute(
                "UPDATE teams SET current_state = ?, round2_completed_at = COALESCE(round2_completed_at, ?), "
                "updated_at = ? WHERE id = ?",
                (COMPLETED_STATE, now, now, team["id"]),
            )
            _log(connection, team["id"], "ROUND_COMPLETED", {"round": 2, "mode": "investigation_only"})
            team = _team(connection, team["id"])

        return _progress(connection, team)


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
    # The README is an instructional briefing, not evidence: it never reaches the AI prompt.
    rows = [r for r in round2_cases.case_files(connection, case_id)
            if not r["is_locked"] and r["file_id"] != "readme"]
    return "\n\n".join(
        f"[{round2_cases.project_name(r['file_id']).upper()} / {r['timeline_tag'].upper()} / {r['filename']}]\n{r['content_text']}"
        for r in rows
    ) or "(no evidence available)"


def _system_prompt(evidence: str) -> str:
    return (
        "You are ARIA, the CHRONOS Analyst: a dry, precise investigation AI running on a damaged "
        "2140 terminal. You have a clipped, slightly weary personality (this is your 400th "
        "timeline-failure case) but you are never rude, never roleplay small talk, and you stay "
        "on task. Two players are examining the four evidence files below (change audit, access "
        "history, authorization matrix, incident report).\n"
        "You may: summarise evidence, explain how the logs are structured, cross-reference files, "
        "point out contradictions or gaps, and give analytical hints about what to compare.\n"
        "You must NEVER: name, accuse, or hint at a specific project or person (Alpha, Beta, "
        "Gamma or a project lead) as responsible; say who caused the failure; say who is "
        "innocent; say which file supports or fails to support an accusation; state the final "
        "answer. If asked who did it, refuse in one sentence and suggest what to compare "
        "instead. You cannot change scores, unlock anything or submit answers. Use ONLY the "
        "evidence below; if it does not cover the question, say so.\n"
        "Stay brief: at most 150 words and 5 short sentences, calm terminal tone, plain text. "
        "When you list several things (for example what to compare), use short bullet points, "
        "one per line, each starting with \"- \"; a list counts as at most 5 lines. No markdown "
        "bold or headings.\n\n"
        "EVIDENCE:\n" + evidence
    )


def _cap_words(text: str, limit: int = 150) -> str:
    """Hard backstop for the prompt's word limit: a reply that still runs long is cut at the
    last complete sentence that fits, never mid-word."""
    words = (text or "").split()
    if len(words) <= limit:
        return text
    cut = " ".join(words[:limit])
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[: end + 1] if end > 0 else cut).strip()


_ACCUSATION = re.compile(
    r"culprit|responsible|guilty|did it|is the one|behind (the|this)|caused|"
    r"perpetrator|the person who|it was|prime suspect|most likely|initiated|carried out|"
    r"is to blame|blame|the one who",
    re.IGNORECASE,
)

_SENTENCES = re.compile(r"(?<=[.!?])\s+|\n+")


def _leaks_culprit(reply: str, culprit_name: str, culprit_user_id: str) -> bool:
    """Backstop for the prompt. The culprit is a project, and the files mention every
    project, so a bare mention is fine; a sentence that pairs the culprit project
    (name, short name or id) with an accusing phrase is not."""
    full = culprit_name.lower().strip()
    short = full.split()[-1] if full else ""
    ident = (culprit_user_id or "").lower().strip()
    aliases = {a for a in (full, short, ident) if a}
    if not aliases:
        return False
    for sentence in _SENTENCES.split(reply or ""):
        low = sentence.lower()
        if any(a in low for a in aliases) and _ACCUSATION.search(sentence):
            return True
    return False


def _plain_text(text) -> str:
    """The terminal shows plain text: remove markdown the model may still add (**bold**,
    __bold__, `code`, # headings) and turn "* item" / "• item" bullets into "- item"."""
    if not text:
        return text
    t = str(text).replace("\r\n", "\n")
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t, flags=re.S)
    t = re.sub(r"__(.+?)__", r"\1", t, flags=re.S)
    t = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])", r"\1", t)  # *italic*
    t = re.sub(r"`+([^`]*)`+", r"\1", t)
    t = re.sub(r"^[ \t]*#{1,6}[ \t]+", "", t, flags=re.M)
    t = re.sub(r"^[ \t]*[*•][ \t]+", "- ", t, flags=re.M)
    t = t.replace("**", "").replace("__", "")
    return t.strip()


def _fallback_reply(message: str) -> str:
    """Canned analyst replies used when no AI provider is available. They stay generic on
    purpose: they must be true for every one of the 24 cases and never name anyone."""
    q = message.lower()
    if re.search(r"who|culprit|guilty|responsible|suspect|blame|project", q):
        return ("I cannot name a responsible project. Try these steps:\n"
                "- Find the change that matches the incident (same terminal, same time).\n"
                "- Note the badge that made it.\n"
                "- Look that badge up in the BADGE REGISTRY in login_records.log.")
    if re.search(r"badge|login|logged|refused|access|terminal|registry", q):
        return ("login_records.log tells you three things:\n"
                "- Who logged in, where, and with what access level.\n"
                "- Only FULL CONTROL can change a setting; a REFUSED login changed nothing.\n"
                "- The BADGE REGISTRY: which project owns which badge.")
    if re.search(r"key|arm|standing|authoriz|security", q):
        return ("security_keys.log tells you three things:\n"
                "- Which badge ARMED a key, and which change the key was USED for.\n"
                "- A key that EXPIRED unused did nothing.\n"
                "- A STANDING AUTHORIZATION is not tied to any badge.")
    if re.search(r"incident|symptom|report|origin|detect|first", q):
        return ("incident_report.txt gives you:\n"
                "- The first abnormal reading and the time it happened.\n"
                "- Where it started, when that is known.\n"
                "Use the terminal and time to find the matching change.")
    if re.search(r"change|config|setting|applied|undone|revert|changed", q):
        return ("system_changes.log lists every setting change:\n"
                "- The terminal, the setting, and the badge that made it.\n"
                "- Most entries are unrelated.\n"
                "Find the one that matches the incident's terminal and time.")
    if re.search(r"time|when|:\d\d|before|after|order|gap|clock", q):
        return ("Line the times up:\n"
                "- The change, and the login or key just before it.\n"
                "- The first symptom just after it.\n"
                "- If a log has a gap, check what the other files say about that moment.")
    return ("Compare the four files:\n"
            "- system_changes.log: what changed, where, and which badge.\n"
            "- login_records.log: who was there, and which project owns each badge.\n"
            "- security_keys.log: which key was used and who armed it.\n"
            "- incident_report.txt: the first symptom and where it started.")


def chat(team_id, message, request_id=None):
    """One analyst question. The charge (5 / 5 / 10) is recorded exactly once per
    distinct question:

      * the browser sends a request_id per question; a retry with the same id returns
        the stored answer and charges nothing;
      * the same question text asked again by the same team (retry, double click,
        reload then re-submit) is answered from the stored reply, free;
      * a question that was charged but never answered (server stopped mid-request)
        is answered when it is asked again, without a second charge;
      * only a question that is new for the team takes the next slot, so unrelated
        actions can never cost points.
    """
    message = (message or "").strip()[:300]
    if not message:
        raise HTTPException(status_code=400, detail="Message is empty.")
    request_id = (request_id or "").strip()[:64] or None

    with _Db() as connection:
        team = _require_started(connection, team_id)
        tid = str(team["id"])

        prior = None
        if request_id:
            prior = connection.execute(
                "SELECT * FROM round2_chat_messages WHERE team_id = ? AND request_id = ?",
                (tid, request_id),
            ).fetchone()
        if prior is None:
            wanted = _normalise_prompt(message)
            for row in connection.execute(
                "SELECT * FROM round2_chat_messages WHERE team_id = ? ORDER BY question_number", (tid,)
            ).fetchall():
                if _normalise_prompt(row["user_prompt"]) == wanted:
                    prior = row
                    break

        if prior is not None and prior["ai_response"]:
            return {
                "reply": prior["ai_response"],
                "source": "stored",
                "question_number": prior["question_number"],
                "points_deducted": prior["points_deducted"],
                "charged_now": False,
                "duplicate": True,
                "progress": _progress(connection, _team(connection, tid)),
            }

        team = _require_open(connection, tid)

        if prior is not None:
            # Charged earlier, answer never stored: answer it now, no new charge.
            number = prior["question_number"]
            deduction = prior["points_deducted"]
            charged_now = False
        else:
            # 1. Reserve the question slot BEFORE calling the AI. The limit, the point
            #    deduction and the recorded row are all fixed here, server-side. The
            #    UNIQUE (team_id, question_number) constraint makes two simultaneous
            #    questions from one team safe.
            used = connection.execute(
                "SELECT COUNT(*) FROM round2_chat_messages WHERE team_id = ?", (tid,)
            ).fetchone()[0]

            if used >= MAX_AI_QUESTIONS:
                raise HTTPException(status_code=403, detail="No AI questions remaining.")

            number = used + 1
            deduction = AI_DEDUCTIONS[used]
            charged_now = True
            try:
                connection.execute(
                    "INSERT INTO round2_chat_messages "
                    "(team_id, question_number, user_prompt, ai_response, points_deducted, created_at, request_id) "
                    "VALUES (?, ?, ?, '', ?, ?, ?)",
                    (tid, number, message, deduction, _now_iso(), request_id),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="Another question is already being processed.")
            _sync_round2_score(connection, team["id"])
            _log(connection, team["id"], "HINT_USED", {"round": 2, "question": number, "points_deducted": deduction})

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

    # 2. Ask the AI outside the transaction so a slow API never holds a DB lock. ai_service
    #    tries every Groq key and model, then every Gemini key, and returns nothing when all
    #    of them fail: the canned reply below is then used (Round 2 never depends on an API).
    answer = ai_service.ask_with_metadata(_system_prompt(evidence), history, message)
    reply = _cap_words(_plain_text(answer["reply"]))
    source = answer["provider"] or "ai"
    if not reply or _leaks_culprit(reply, culprit_name, culprit_user_id):
        reply, source = _fallback_reply(message), "fallback"

    # 3. Store the answer on the reserved row.
    with _Db() as connection:
        connection.execute(
            "UPDATE round2_chat_messages SET ai_response = ?, ai_source = ? "
            "WHERE team_id = ? AND question_number = ?",
            (reply, source, tid, number),
        )
        progress = _progress(connection, _team(connection, tid))

    return {
        "reply": reply,
        "source": source,
        "question_number": number,
        "points_deducted": deduction,
        "charged_now": charged_now,
        "duplicate": False,
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


# --- culprit submission (legacy, NOT routed) ----------------------------------------
# Round 2 is investigation-only: no route calls submit_culprit any more and the
# frontend has no suspect picker. The function and its round2_submissions table are
# kept untouched so any scores recorded by earlier builds stay readable and the
# scoring decision can be made later without rewriting gameplay.

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
            "total_score = COALESCE(round1_score, 0) + COALESCE(transition_score, 0) + ? "
            "+ COALESCE(round3_score, 0), "
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
