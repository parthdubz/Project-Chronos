"""
Project Chronos — Physical Transition Round Service
Sits between Round 1 and Round 2. The team is given a clue, works out where it points,
finds a password at that physical location and types it in. Worth 20 points, minus a
penalty per wrong attempt:

  wrong attempts so far -> total penalty      correct answer on the next try scores
  0                        0                   20
  1                       -5                   15
  2                      -10                   10
  3 (round locked)       -20                    0   (no more attempts, team may continue)

Passwords live in a Google Sheet (one tab per zone, see sheet_passwords.py). A correct
password gets its Status checkbox ticked in the same call, so it can be used only once and
never by another team. Nothing new is stored in a new table: the team's clue, score and
finish time are columns on `teams`, attempts go into `submissions`, events into `game_logs`.
The team's current_state is never changed by this round (it stays ROUND1_COMPLETED), so
Round 2/3 keep working exactly as before.

Clue allocation (see pick_clue_id): a zone gets at most 2 teams per cycle, zones fill 2-2-2
before any zone repeats, and a clue another team is still holding is never handed out again.
"""

import json
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..database.connection import get_connection
from .sheet_passwords import PasswordServiceError, consume_password

TRANSITION_ROUND = 15  # value of `submissions.round` for transition attempts
MAX_SCORE = 20.0
MAX_ATTEMPTS = 3
# Penalty applied by each wrong attempt (cumulative: 5, 10, 20).
ATTEMPT_PENALTIES = (5.0, 5.0, 10.0)

ZONES = ("past", "present", "future")
CLUES_PER_ZONE = 10
ZONE_CAP_PER_CYCLE = 2  # teams per zone before every zone has had its turn

# One verification at a time within this process (the sheet call and the DB write must
# not interleave for the same team; the sheet script locks across processes itself).
_verify_lock = threading.Lock()


class TransitionError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(state) -> str:
    # The rounds spell states differently (ROUND1_COMPLETED / ROUND_1_COMPLETED).
    return (state or "").replace("_", "").upper()


def _is_eligible(state) -> bool:
    return _norm(state) == "ROUND1COMPLETED"


# ---------------------------------------------------------------------------------------
# Clue / zone allocation
# ---------------------------------------------------------------------------------------
def zone_for_clue(clue_id: int) -> str:
    """clue_id is 0..29: zone = clue_id // 10, clue within the zone = clue_id % 10."""
    return ZONES[clue_id // CLUES_PER_ZONE]


def pick_clue_id(assignments: List[tuple]) -> int:
    """
    Chooses the next clue. `assignments` is [(clue_id, still_holding)] for every team that has
    already been given a clue.

    Zone: a zone gets at most 2 teams per cycle. Zones fill 2-2-2; only once every zone has its
    2 does the next cycle start and zones may repeat. Within the open zones the emptiest one
    wins (ties follow ZONES order).

    Clue: never a clue another team is still holding unless every clue in the zone is held;
    after that the least-used clue wins, so a clue only repeats once the zone's 10 are spent.
    """
    zone_counts = [0] * len(ZONES)
    use_count = [0] * (len(ZONES) * CLUES_PER_ZONE)
    held_count = [0] * (len(ZONES) * CLUES_PER_ZONE)
    for clue_id, holding in assignments:
        zone_counts[clue_id // CLUES_PER_ZONE] += 1
        use_count[clue_id] += 1
        if holding:
            held_count[clue_id] += 1

    cycle = min(zone_counts) // ZONE_CAP_PER_CYCLE
    open_zones = [z for z, n in enumerate(zone_counts) if n // ZONE_CAP_PER_CYCLE == cycle]
    zone = min(open_zones, key=lambda z: (zone_counts[z], z))

    candidates = range(zone * CLUES_PER_ZONE, (zone + 1) * CLUES_PER_ZONE)
    return min(candidates, key=lambda c: (held_count[c], use_count[c], c))


def _ensure_clue(connection, team_id: int) -> Optional[int]:
    """
    The team's clue, allocating one (atomically) the first time an eligible team asks.
    Returns None while the team has not finished Round 1.
    """
    row = connection.execute(
        "SELECT transition_clue_id, current_state FROM teams WHERE id = ?", (team_id,)
    ).fetchone()
    if row is None:
        raise TransitionError(f"Team {team_id} not found", status_code=404)
    if row["transition_clue_id"] is not None:
        return int(row["transition_clue_id"])
    if not _is_eligible(row["current_state"]):
        return None

    owns_transaction = not connection.in_transaction
    if owns_transaction:
        connection.execute("BEGIN IMMEDIATE")  # serialise allocations across requests
    try:
        row = connection.execute(
            "SELECT transition_clue_id FROM teams WHERE id = ?", (team_id,)
        ).fetchone()
        if row["transition_clue_id"] is not None:
            return int(row["transition_clue_id"])

        taken = connection.execute(
            "SELECT transition_clue_id, transition_completed_at FROM teams "
            "WHERE transition_clue_id IS NOT NULL"
        ).fetchall()
        clue_id = pick_clue_id([
            (int(t["transition_clue_id"]), not t["transition_completed_at"]) for t in taken
        ])
        connection.execute(
            "UPDATE teams SET transition_clue_id = ? WHERE id = ?", (clue_id, team_id)
        )
        _log_event(connection, team_id, "TRANSITION_CLUE_ASSIGNED", {"clue_id": clue_id})
        if owns_transaction:
            connection.commit()
        return clue_id
    except Exception:
        if owns_transaction:
            connection.rollback()
        raise


# ---------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------
def _log_event(connection, team_id: int, event_type: str, data: Dict[str, Any]) -> None:
    connection.execute(
        "INSERT INTO game_logs (team_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)",
        (team_id, event_type, json.dumps(data), _now_iso()),
    )


def _get_team(connection, team_id: int):
    team = connection.execute(
        "SELECT id, team_name, current_state, transition_score, transition_clue_id, transition_completed_at, "
        "round1_score, round2_score, round3_score FROM teams WHERE id = ?",
        (team_id,),
    ).fetchone()
    if team is None:
        raise TransitionError(f"Team {team_id} not found", status_code=404)
    return team


def _wrong_attempts(connection, team_id: int) -> int:
    row = connection.execute(
        "SELECT COUNT(*) AS n FROM submissions WHERE team_id = ? AND round = ? AND is_correct = 0",
        (team_id, TRANSITION_ROUND),
    ).fetchone()
    return int(row["n"])


def _started_at(connection, team_id: int) -> Optional[str]:
    """When the team pressed START STOPWATCH (its TRANSITION_STARTED log event), if it did."""
    row = connection.execute(
        "SELECT created_at FROM game_logs WHERE team_id = ? AND event_type = 'TRANSITION_STARTED' "
        "ORDER BY id LIMIT 1",
        (team_id,),
    ).fetchone()
    return row["created_at"] if row else None


def _stopped_at(connection, team_id: int) -> Optional[str]:
    """When the team pressed END STOPWATCH (its TRANSITION_STOPPED log event), if it did."""
    row = connection.execute(
        "SELECT created_at FROM game_logs WHERE team_id = ? AND event_type = 'TRANSITION_STOPPED' "
        "ORDER BY id LIMIT 1",
        (team_id,),
    ).fetchone()
    return row["created_at"] if row else None


def _parse_ts(value: Optional[str]):
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)  # stored as UTC


def _elapsed_ms(started_at: Optional[str], stopped_at: Optional[str]) -> Optional[int]:
    """Stopwatch value: frozen at the stop time once stopped, otherwise running up to now."""
    start = _parse_ts(started_at)
    if start is None:
        return None
    end = _parse_ts(stopped_at) or datetime.now(timezone.utc)
    return max(0, int((end - start).total_seconds() * 1000))


def _stop_if_running(connection, team_id: int) -> None:
    """Freeze the stopwatch at this moment (once). Needs a started stopwatch."""
    started = _started_at(connection, team_id)
    if started is None or _stopped_at(connection, team_id) is not None:
        return
    now = _now_iso()
    _log_event(connection, team_id, "TRANSITION_STOPPED", {"elapsed_ms": _elapsed_ms(started, now)})
    connection.commit()


def _snapshot(team, wrong: int, connection=None) -> Dict[str, Any]:
    completed = bool(team["transition_completed_at"])
    has_clue = team["transition_clue_id"] is not None
    started_at = _started_at(connection, team["id"]) if connection is not None else None
    stopped_at = _stopped_at(connection, team["id"]) if (connection is not None and started_at) else None
    return {
        "started": started_at is not None,
        "started_at": started_at,
        "stopped": stopped_at is not None,
        "stopped_at": stopped_at,
        # Server-side stopwatch value: running -> up to now, stopped -> frozen. The browser
        # resumes from this, so a reload neither restarts nor keeps counting a stopped watch.
        "elapsed_ms": _elapsed_ms(started_at, stopped_at),
        "team_id": team["id"],
        "status": "COMPLETED" if completed else ("ACTIVE" if has_clue else "NOT_STARTED"),
        "clue_id": team["transition_clue_id"],
        "attempts_used": wrong,
        "attempts_remaining": 0 if completed else max(0, MAX_ATTEMPTS - wrong),
        "max_attempts": MAX_ATTEMPTS,
        "score": float(team["transition_score"] or 0.0) if completed else None,
        "max_score": MAX_SCORE,
        "locked": completed and wrong >= MAX_ATTEMPTS,
    }


def _penalty_after(wrong: int) -> float:
    return sum(ATTEMPT_PENALTIES[: min(wrong, len(ATTEMPT_PENALTIES))])


# ---------------------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------------------
class TransitionService:
    @staticmethod
    def get_state(team_id: int) -> Dict[str, Any]:
        connection = get_connection()
        try:
            _ensure_clue(connection, team_id)
            team = _get_team(connection, team_id)
            return _snapshot(team, _wrong_attempts(connection, team_id), connection)
        finally:
            connection.close()

    @staticmethod
    def progress(team_id: int) -> Dict[str, Any]:
        """Read-only (never allocates a clue): where the team is in the transition round, so a
        page reload can put it back on the right screen."""
        connection = get_connection()
        try:
            team = _get_team(connection, team_id)
            return {
                "eligible": _is_eligible(team["current_state"]),
                "clue_assigned": team["transition_clue_id"] is not None,
                "started": _started_at(connection, team_id) is not None,
                "stopped": _stopped_at(connection, team_id) is not None,
                "completed": bool(team["transition_completed_at"]),
            }
        finally:
            connection.close()

    @staticmethod
    def start(team_id: int) -> Dict[str, Any]:
        """Records that the team started the stopwatch. Safe to call repeatedly."""
        connection = get_connection()
        try:
            clue_id = _ensure_clue(connection, team_id)
            team = _get_team(connection, team_id)
            if team["transition_completed_at"]:
                return _snapshot(team, _wrong_attempts(connection, team_id), connection)
            if clue_id is None:
                raise TransitionError("Round 1 must be completed before the transition round.", status_code=409)
            already = connection.execute(
                "SELECT 1 FROM game_logs WHERE team_id = ? AND event_type = 'TRANSITION_STARTED'",
                (team_id,),
            ).fetchone()
            if not already:
                _log_event(connection, team_id, "TRANSITION_STARTED", {"clue_id": clue_id})
                connection.commit()
            return _snapshot(team, _wrong_attempts(connection, team_id), connection)
        finally:
            connection.close()

    @staticmethod
    def stop(team_id: int) -> Dict[str, Any]:
        """END STOPWATCH: freeze the duration on the server. Safe to call repeatedly; once
        stopped the value never changes again (also not after a reload)."""
        connection = get_connection()
        try:
            _ensure_clue(connection, team_id)
            team = _get_team(connection, team_id)
            if not team["transition_completed_at"]:
                if _started_at(connection, team_id) is None:
                    raise TransitionError("Start the stopwatch first.", status_code=409)
                _stop_if_running(connection, team_id)
            return _snapshot(team, _wrong_attempts(connection, team_id), connection)
        finally:
            connection.close()

    @staticmethod
    def verify(team_id: int, password: str) -> Dict[str, Any]:
        entered = (password or "").strip().upper()
        if not entered:
            raise TransitionError("Enter the password you found.", status_code=400)

        with _verify_lock:
            connection = get_connection()
            try:
                clue_id = _ensure_clue(connection, team_id)
                team = _get_team(connection, team_id)
                wrong = _wrong_attempts(connection, team_id)

                if team["transition_completed_at"]:
                    # Already finished (correct, or locked after 3 wrong): never re-score.
                    return {**_snapshot(team, wrong, connection), "correct": None, "completed": True,
                            "message": "Transition round already completed."}
                if clue_id is None:
                    raise TransitionError("Round 1 must be completed before the transition round.", status_code=409)

                _stop_if_running(connection, team_id)  # entering a password ends the stopwatch

                # Ask the sheet first, without holding a database write lock. A correct
                # password is marked used in the sheet by this very call. If the sheet cannot
                # be reached nothing is recorded and the attempt is NOT counted.
                try:
                    correct = consume_password(
                        zone_for_clue(clue_id), entered,
                        team_id=team_id, team_name=team["team_name"],
                    )
                except PasswordServiceError as err:
                    raise TransitionError(
                        "The password service is unreachable right now. "
                        "Your attempt was not counted; please try again in a moment.",
                        status_code=503,
                    ) from err

                connection.execute("BEGIN IMMEDIATE")
                team = _get_team(connection, team_id)
                wrong = _wrong_attempts(connection, team_id)
                if team["transition_completed_at"]:  # finished by a parallel request
                    connection.rollback()
                    return {**_snapshot(team, wrong, connection), "correct": None, "completed": True,
                            "message": "Transition round already completed."}
                now = _now_iso()

                if correct:
                    score = MAX_SCORE - _penalty_after(wrong)
                    delta = score
                    new_wrong = wrong
                    completed = True
                else:
                    new_wrong = wrong + 1
                    delta = -ATTEMPT_PENALTIES[min(wrong, len(ATTEMPT_PENALTIES) - 1)]
                    completed = new_wrong >= MAX_ATTEMPTS
                    score = max(0.0, MAX_SCORE - _penalty_after(new_wrong)) if completed else None

                connection.execute(
                    """
                    INSERT INTO submissions (team_id, round, reference_id, answer, is_correct, points_awarded, submitted_at)
                    VALUES (?, ?, 'TRANSITION', ?, ?, ?, ?)
                    """,
                    (team_id, TRANSITION_ROUND, entered, 1 if correct else 0, delta, now),
                )
                _log_event(connection, team_id, "TRANSITION_ATTEMPT", {
                    "correct": correct, "attempt": wrong + 1, "points_delta": delta,
                })

                if completed:
                    connection.execute(
                        """
                        UPDATE teams
                        SET transition_score = ?, transition_completed_at = ?,
                            total_score = COALESCE(round1_score, 0) + ? + COALESCE(round2_score, 0)
                                          + COALESCE(round3_score, 0),
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (score, now, score, now, team_id),
                    )
                    _log_event(connection, team_id, "TRANSITION_COMPLETED", {
                        "result": "CORRECT" if correct else "LOCKED", "score": score,
                    })
                connection.commit()

                team = _get_team(connection, team_id)
                return {
                    **_snapshot(team, new_wrong, connection),
                    "correct": correct,
                    "completed": completed,
                    "message": (
                        "Credential accepted." if correct
                        else ("No attempts remaining. Transition closed." if completed else "Credential rejected.")
                    ),
                }
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()
