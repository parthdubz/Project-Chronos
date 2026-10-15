"""
Secure mode (kiosk-style play) support.

The browser game runs fullscreen with the keyboard locked (Alt+Tab, Esc, Ctrl+W, F12 ... are
swallowed by the page, see frontend/src/utils/secureMode.js). The server's part is small:

  * GET  /api/security/config   whether secure mode is ON. The host switches it off for testing
                                with CHRONOS_SECURE_MODE=0 in .env (default: ON). No login needed
                                because the login page asks before a team exists.
  * POST /api/security/event    a team's page reports that the player tried a blocked key, left
                                the window or left fullscreen. It is written to game_logs, so the
                                host sees it in the admin "Team Logs" tab. Needs the team token.
"""

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..config import setting
from ..database.connection import get_connection
from ..services import key_blocker

router = APIRouter(prefix="/api/security", tags=["Security"])
team_router = APIRouter(prefix="/api/security", tags=["Security"])

# kind sent by the page -> event type stored in game_logs
KINDS = {
    "KEY_BLOCKED": "SECURITY_KEY_BLOCKED",
    "FOCUS_LOST": "SECURITY_FOCUS_LOST",
    "FULLSCREEN_EXIT": "SECURITY_FULLSCREEN_EXIT",
    "LOCK_UNAVAILABLE": "SECURITY_LOCK_UNAVAILABLE",
}
DEDUPE_SECONDS = 2.0


def secure_mode_enabled() -> bool:
    return setting("CHRONOS_SECURE_MODE", "1").strip().lower() not in {"0", "false", "off", "no"}


class EventBody(BaseModel):
    team_id: int
    kind: str = Field(..., max_length=32)
    detail: str = Field(default="", max_length=60)


@router.get("/config")
def get_config():
    return {"secure_mode": secure_mode_enabled()}


@router.get("/keys-state")
def keys_state(request: Request, name: str = "", blocking: int = 0, v: str = ""):
    """Polled by KeyBlocker.exe on a player laptop: should it block the keys right now?
    Public on purpose (the exe has no login); it only reveals one on/off value."""
    ip = request.client.host if request.client else ""
    key_blocker.heartbeat(name, ip, bool(blocking), v)
    return {"locked": key_blocker.get_state()["locked"], "poll_seconds": key_blocker.POLL_SECONDS}


@team_router.post("/event")
def post_event(body: EventBody):
    event_type = KINDS.get(body.kind.upper())
    if event_type is None:
        return {"logged": False}

    now = datetime.now(timezone.utc)
    connection = get_connection()
    try:
        detail = body.detail.strip()
        last = connection.execute(
            "SELECT created_at, event_data FROM game_logs WHERE team_id = ? AND event_type = ? "
            "ORDER BY id DESC LIMIT 1",
            (body.team_id, event_type),
        ).fetchone()
        if last and last["created_at"]:
            try:
                prev = datetime.fromisoformat(str(last["created_at"]).replace("Z", "+00:00"))
                if prev.tzinfo is None:
                    prev = prev.replace(tzinfo=timezone.utc)
                same = json.loads(last["event_data"] or "{}").get("detail", "") == detail
                # the same report twice in a row within a moment is one event
                if same and (now - prev).total_seconds() < DEDUPE_SECONDS:
                    return {"logged": False}
            except (ValueError, AttributeError):
                pass
        connection.execute(
            "INSERT INTO game_logs (team_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)",
            (body.team_id, event_type, json.dumps({"detail": detail}), now.isoformat()),
        )
        connection.commit()
        return {"logged": True}
    finally:
        connection.close()
