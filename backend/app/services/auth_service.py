import json
import sqlite3
from datetime import datetime, timezone

from fastapi import HTTPException

from ..database.connection import get_connection
from .round2_cases import assign_case

DEFAULT_STATE = "READY"

CALLSIGN_TAKEN_MESSAGE = (
    "Engineers have been already assigned with this Callsign name."
)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean(value):
    return (value or "").strip()


def _team_payload(row, message):
    return {
        "team_id": row["id"],
        "team_name": row["team_name"],
        "member_1_name": row["member_1_name"],
        "member_2_name": row["member_2_name"],
        "member_1_prn": row["member_1_prn"],
        "member_2_prn": row["member_2_prn"],
        "current_state": row["current_state"] or DEFAULT_STATE,
        "message": message,
    }


def _prns_match(row, prn_1, prn_2):
    """
    True when the submitted PRNs are the two PRNs registered for the team
    (case-insensitive, either order). Teams with no stored PRNs can never match.
    """
    stored = (
        (row["member_1_prn"] or "").strip().lower(),
        (row["member_2_prn"] or "").strip().lower(),
    )
    if not all(stored):
        return False

    submitted = (prn_1.lower(), prn_2.lower())
    return submitted == stored or submitted == stored[::-1]


def _log_event(connection, team_id, event_type, data):
    connection.execute(
        """
        INSERT INTO game_logs (team_id, event_type, event_data, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (team_id, event_type, json.dumps(data), _now()),
    )


def _find_team(connection, team_name):
    return connection.execute(
        "SELECT * FROM teams WHERE team_name = ? COLLATE NOCASE",
        (team_name,),
    ).fetchone()


def _login_returning_team(connection, row, prn_1, prn_2):
    """Existing team name: only the PRNs are verified. Nothing registered is changed."""
    if not _prns_match(row, prn_1, prn_2):
        raise HTTPException(status_code=409, detail=CALLSIGN_TAKEN_MESSAGE)

    connection.execute(
        "UPDATE teams SET updated_at = ? WHERE id = ?",
        (_now(), row["id"]),
    )
    _log_event(connection, row["id"], "LOGIN", {"result": "RETURNING_TEAM"})
    connection.commit()
    return _team_payload(row, "LOGIN_SUCCESS")


def login_team(team_name, member_1_name, member_2_name, member_1_prn, member_2_prn):
    """
    Single entry point for team authentication.

    - New team name           -> team is created (sequential id) and logged in.
    - Existing team name      -> logged in only if both PRNs match the registered ones.
    - Existing, PRNs differ   -> 409, the registered team is left untouched.
    """
    team_name = _clean(team_name)
    member_1_name = _clean(member_1_name)
    member_2_name = _clean(member_2_name)
    prn_1 = _clean(member_1_prn)
    prn_2 = _clean(member_2_prn)

    if not team_name:
        raise HTTPException(status_code=400, detail="Team Name designation is required.")
    if not member_1_name or not member_2_name:
        raise HTTPException(
            status_code=400,
            detail="Both Member 1 and Member 2 names are required.",
        )
    if not prn_1 or not prn_2:
        raise HTTPException(
            status_code=400,
            detail="PRN credentials for both Member 1 and Member 2 are required.",
        )

    connection = get_connection()
    try:
        # Take the write lock up front so two teams registering at the same moment
        # can never be handed the same id.
        connection.execute("BEGIN IMMEDIATE")

        existing = _find_team(connection, team_name)
        if existing:
            return _login_returning_team(connection, existing, prn_1, prn_2)

        next_id = connection.execute(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM teams"
        ).fetchone()[0]
        now = _now()

        connection.execute(
            """
            INSERT INTO teams (
                id, team_name, member_1_name, member_2_name,
                member_1_prn, member_2_prn, current_state,
                round1_score, round2_score, round3_score, total_score,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
            """,
            (next_id, team_name, member_1_name, member_2_name,
             prn_1, prn_2, DEFAULT_STATE, now, now),
        )

        # Keep AUTOINCREMENT in step so ids stay consecutive after deletions.
        connection.execute(
            "UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM teams) "
            "WHERE name = 'teams'"
        )

        # Round 2: the team's case is decided the moment the team is created. The
        # savepoint means login still succeeds if the Round 2 tables are unavailable
        # (the case is then assigned when Round 2 starts).
        connection.execute("SAVEPOINT round2_case")
        try:
            assign_case(connection, next_id)
        except Exception:
            connection.execute("ROLLBACK TO SAVEPOINT round2_case")
        connection.execute("RELEASE SAVEPOINT round2_case")

        _log_event(connection, next_id, "LOGIN", {"result": "REGISTERED_NEW_TEAM"})
        connection.commit()

        created = connection.execute(
            "SELECT * FROM teams WHERE id = ?", (next_id,)
        ).fetchone()
        return _team_payload(created, "TEAM_REGISTERED")

    except sqlite3.IntegrityError:
        # Lost a race on the unique team name: someone registered it a moment ago.
        connection.rollback()
        raise HTTPException(status_code=409, detail=CALLSIGN_TAKEN_MESSAGE)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def get_team_session(team_id):
    """Used after a page reload to confirm the stored session's team still exists."""
    connection = get_connection()
    try:
        row = connection.execute(
            "SELECT * FROM teams WHERE id = ?", (team_id,)
        ).fetchone()
    finally:
        connection.close()

    if not row:
        raise HTTPException(status_code=404, detail="Team not found.")

    return {
        "team_id": row["id"],
        "team_name": row["team_name"],
        "current_state": row["current_state"] or DEFAULT_STATE,
    }
