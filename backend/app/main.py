import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .database.schema import create_tables, seed_round1_items_if_empty
from .routes.auth import router as auth_router
from .routes.round1 import router as round1_router
from .routes.round2 import router as round2_router
from .routes.round3 import router as round3_router
from .routes.transition import router as transition_router
from .routes.dev import router as dev_router
from .routes.admin import router as admin_router
from .routes.security import router as security_router, team_router as security_team_router
from .services.round2_service import init_round2
from .services.round3_service import init_round3
from .services.team_session import require_team


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    seed_round1_items_if_empty()  # no-op when items already exist
    init_round2()  # Round 2 tables + the 24 cases (no-op when already loaded)
    init_round3()  # Round 3 tables (idempotent; upgrades older Round 3 tables)
    yield


# Some Windows Python installs do not know .webp (the Round 1 images); register it so the
# static files are always served as image/webp.
mimetypes.add_type("image/webp", ".webp")

app = FastAPI(
    title="Project Chronos API",
    lifespan=lifespan
)


# CORS: only needed when the frontend is served from a different origin than the API
# (e.g. a separately hosted frontend). Set CORS_ORIGINS="https://a.com,https://b.com"
# in production; defaults to allowing any origin.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "*").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Serve Round 1 images
BASE_DIR = Path(__file__).resolve().parents[1]

app.mount(
    "/static",
    StaticFiles(directory=BASE_DIR / "static"),
    name="static"
)

# Bruno (home-screen idle-sprite overlay): its own top-level, independently-tracked
# directory - not inside frontend/public - so it deploys with a plain git clone/pull
# like everything else, instead of depending on files hand-copied into the frontend.
app.mount(
    "/bruno-assets",
    StaticFiles(directory=BASE_DIR.parent / "bruno"),
    name="bruno-assets"
)


# Built frontend (frontend/dist, created by `npm run build`). When present, the
# backend serves the whole app so one process hosts everything.
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"


# The built bundle in /assets has hashed names and can be cached; every other frontend file
# (index.html, the Round 2 page, sounds) must be revalidated so an update is never hidden
# behind a stale browser copy.
NO_CACHE = {"Cache-Control": "no-cache"}


@app.get("/")
def home():
    if FRONTEND_INDEX.is_file():
        return FileResponse(FRONTEND_INDEX, headers=NO_CACHE)
    return {"message": "Project Chronos API is running"}


app.include_router(
    auth_router,
    prefix="/api/auth"
)

# Rounds 1-3 act on a team, so every call must carry that team's session token
# (X-Team-Token, issued at login). A team cannot act as another team by editing
# the team_id in a request.
app.include_router(
    round1_router,
    prefix="/api/round1",
    dependencies=[Depends(require_team)],
)

# Round 2 and Round 3 routers carry their own /api/roundN prefix.
app.include_router(round2_router, dependencies=[Depends(require_team)])
app.include_router(round3_router, dependencies=[Depends(require_team)])
# Transition Round (between Round 1 and Round 2): clue, stopwatch result, physical password.
app.include_router(transition_router, dependencies=[Depends(require_team)])
# Tester shortcut (Ctrl+Shift+Alt+K): 404 unless CHRONOS_ENABLE_SKIP=1.
app.include_router(dev_router, dependencies=[Depends(require_team)])

# Secure mode: public config + team-authenticated violation reports (shown in admin Team Logs).
app.include_router(security_router)
app.include_router(security_team_router, dependencies=[Depends(require_team)])

# Host-only: every route except /login needs the admin bearer token.
app.include_router(admin_router)


# Must stay LAST: catch-all for the frontend's files and client-side routes.
@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend(full_path: str):
    if not FRONTEND_INDEX.is_file() or full_path.startswith(("api/", "static/")):
        raise HTTPException(status_code=404, detail="Not found")

    requested = (FRONTEND_DIST / full_path).resolve()
    if requested.is_file() and FRONTEND_DIST.resolve() in requested.parents:
        hashed = full_path.startswith("assets/")
        return FileResponse(requested, headers=None if hashed else NO_CACHE)

    return FileResponse(FRONTEND_INDEX, headers=NO_CACHE)
