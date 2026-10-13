"""
Team session tokens.

Login hands every team a random token (teams.session_token). Every Round 1,
Round 2 and Round 3 API call must send it in the X-Team-Token header together
with the team_id it acts on, so a team cannot read or change another team's data
just by editing a request parameter. The token is stored and compared on the
server only; the browser keeps it with the rest of the login session.
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import HTTPException, Request

from ..database.connection import get_connection

TOKEN_HEADER = "x-team-token"
_BODY_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

INVALID_SESSION = "Team session is missing or has expired. Please log in again."


def new_token() -> str:
    return secrets.token_urlsafe(32)


def issue_token(connection, team_id) -> str:
    """The team's existing token, or a new one (teams that predate tokens get one
    the next time they log in). The caller commits."""
    row = connection.execute(
        "SELECT session_token FROM teams WHERE id = ?", (team_id,)
    ).fetchone()
    current = (row["session_token"] if row else "") or ""
    if current:
        return current

    token = new_token()
    connection.execute("UPDATE teams SET session_token = ? WHERE id = ?", (token, team_id))
    return token


def token_matches(team_id: int, token: str) -> bool:
    if not token:
        return False
    connection = get_connection()
    try:
        row = connection.execute(
            "SELECT session_token FROM teams WHERE id = ?", (team_id,)
        ).fetchone()
    finally:
        connection.close()

    stored = (row["session_token"] if row else "") or ""
    return bool(stored) and hmac.compare_digest(stored.encode(), token.encode())


async def require_team(request: Request) -> int:
    """FastAPI dependency: the request's team_id (query string or JSON body) must
    be accompanied by that team's session token."""
    raw = request.query_params.get("team_id")
    body_raw = None
    if request.method in _BODY_METHODS:
        try:
            body = await request.json()
        except Exception:
            body = None
        if isinstance(body, dict):
            body_raw = body.get("team_id")
    # The handlers act on the body's team_id for POSTs: if a request names two different teams
    # (own id in the query, someone else's in the body) it must not pass as the first one.
    if raw is not None and body_raw is not None and str(raw).strip() != str(body_raw).strip():
        raise HTTPException(status_code=400, detail="team_id does not match.")
    if raw is None:
        raw = body_raw

    try:
        team_id = int(str(raw).strip())
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="team_id is required.")

    if not 0 < team_id < 2**31:  # no such team; also keeps SQLite from overflowing on huge ids
        raise HTTPException(status_code=401, detail=INVALID_SESSION)

    token = request.headers.get(TOKEN_HEADER, "").strip()
    if not token_matches(team_id, token):
        raise HTTPException(status_code=401, detail=INVALID_SESSION)

    return team_id
