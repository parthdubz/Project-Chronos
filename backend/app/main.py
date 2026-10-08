import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .database.schema import create_tables, seed_round1_items_if_empty
from .routes.auth import router as auth_router
from .routes.round1 import router as round1_router
from .routes.round2 import router as round2_router
from .services.round2_service import init_round2


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    seed_round1_items_if_empty()  # no-op when items already exist
    init_round2()  # Round 2 tables + the 24 cases (no-op when already loaded)
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


# Built frontend (frontend/dist, created by `npm run build`). When present, the
# backend serves the whole app so one process hosts everything.
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"


@app.get("/")
def home():
    if FRONTEND_INDEX.is_file():
        return FileResponse(FRONTEND_INDEX)
    return {"message": "Project Chronos API is running"}


app.include_router(
    auth_router,
    prefix="/api/auth"
)

app.include_router(
    round1_router,
    prefix="/api/round1"
)

# Round 2 router carries its own /api/round2 prefix.
app.include_router(round2_router)


# Must stay LAST: catch-all for the frontend's files and client-side routes.
@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend(full_path: str):
    if not FRONTEND_INDEX.is_file() or full_path.startswith(("api/", "static/")):
        raise HTTPException(status_code=404, detail="Not found")

    requested = (FRONTEND_DIST / full_path).resolve()
    if requested.is_file() and FRONTEND_DIST.resolve() in requested.parents:
        return FileResponse(requested)

    return FileResponse(FRONTEND_INDEX)
