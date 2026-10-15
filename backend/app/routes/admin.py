"""
Admin API (host only). Everything except /login needs the bearer token that
/login returns; with CHRONOS_ADMIN_PASSWORD unset the whole API answers 503.
There is no public leaderboard and no unauthenticated export.
"""

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from ..services import admin_service as svc
from ..services import key_blocker

router = APIRouter(prefix="/api/admin", tags=["Admin"])


class LoginBody(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


@router.post("/login")
def login(body: LoginBody, request: Request):
    if not svc.admin_enabled():
        raise HTTPException(status_code=503, detail="Admin access is not configured on this server.")
    svc.check_login_allowed(request)
    role = svc.authenticate(body.password, svc._client_key(request))
    if role is None:
        svc.record_login_failure(request)
        raise HTTPException(status_code=401, detail="Invalid or already used password.")
    return {"success": True, "token": svc.make_token(role), "role": role,
            "expires_in": svc.TOKEN_TTL_SECONDS}


@router.get("/session")
def session(role: str = Depends(svc.require_admin)):
    return {"valid": True, "role": role}


class PasswordsBody(BaseModel):
    passwords: Optional[List[str]] = Field(default=None, max_length=100)
    generate: int = Field(default=0, ge=0, le=100)


class SkipSwitchBody(BaseModel):
    enabled: bool


@router.get("/dev-skip", dependencies=[Depends(svc.require_master)])
def get_dev_skip():
    from ..services import dev_skip

    return {"enabled": dev_skip.enabled()}


@router.post("/dev-skip", dependencies=[Depends(svc.require_master)])
def set_dev_skip(body: SkipSwitchBody):
    from ..services import dev_skip

    return dev_skip.set_enabled(body.enabled)


@router.get("/ai-status", dependencies=[Depends(svc.require_admin)])
def get_ai_status():
    """Round 2 analyst AI: providers, number of keys, models, resting keys, last error.
    Counts and names only; a key is never returned."""
    from ..services import ai_service

    return ai_service.status()


@router.get("/passwords", dependencies=[Depends(svc.require_master)])
def get_passwords():
    return svc.list_passwords()


@router.post("/passwords", dependencies=[Depends(svc.require_master)])
def add_passwords(body: PasswordsBody):
    return svc.add_passwords(body.passwords or [], body.generate)


@router.delete("/passwords/{password_id}", dependencies=[Depends(svc.require_master)])
def delete_password(password_id: int):
    if not svc.delete_unused_password(password_id):
        raise HTTPException(status_code=404, detail="No unused password with that id.")
    return {"deleted": True}


@router.get("/leaderboard", dependencies=[Depends(svc.require_admin)])
def get_leaderboard():
    return svc.leaderboard()


@router.delete("/teams/{team_id}", dependencies=[Depends(svc.require_master)])
def delete_team(team_id: int):
    """Permanently delete one team and all of its data (master admin only)."""
    return svc.delete_team(team_id)


@router.get("/export-csv", dependencies=[Depends(svc.require_admin)])
def export_csv():
    filename = f"chronos_leaderboard_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=svc.leaderboard_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/team-activity", dependencies=[Depends(svc.require_admin)])
def get_team_activity_summary():
    """Every team with its current stage and last action (host Team Logs tab)."""
    return svc.team_activity_summary()


@router.get("/team-activity/{team_id}", dependencies=[Depends(svc.require_admin)])
def get_team_activity(team_id: int, limit: int = Query(500, ge=1, le=2000)):
    """Readable chronological timeline of one team."""
    return svc.team_activity(team_id, limit)


@router.get("/logs", dependencies=[Depends(svc.require_admin)])
def get_logs(limit: int = Query(100, ge=1, le=1000)):
    return svc.recent_logs(limit)


class KeyBlockerBody(BaseModel):
    locked: bool


@router.get("/keyblocker", dependencies=[Depends(svc.require_admin)])
def get_keyblocker():
    """Switch state plus the laptops running KeyBlocker.exe (admin Key Blocker tab)."""
    return {**key_blocker.get_state(), "clients": key_blocker.clients()}


@router.post("/keyblocker", dependencies=[Depends(svc.require_admin)])
def set_keyblocker(body: KeyBlockerBody):
    state = key_blocker.set_locked(body.locked)
    return {**state, "clients": key_blocker.clients()}
