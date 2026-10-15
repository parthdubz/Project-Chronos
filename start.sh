#!/usr/bin/env bash
# PROJECT CHRONOS launcher for macOS / Linux (Windows: use start.bat).
#
#  * Builds the frontend once so the backend serves EVERYTHING from one address
#    (no localhost / port numbers baked into the app).
#  * Starts the backend on 0.0.0.0, so other devices on the same network can open it.
#  * The backend creates the database and loads the Round 1 items on first start.
#
# Usage:   bash start.sh            (port 8000)
#          bash start.sh 8080       (custom port)
# Set NO_BROWSER=1 to skip opening the browser. Stop with Ctrl+C.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8000}"
VENV="$ROOT/.venv"

fail() { echo "[ERROR] $*" >&2; exit 1; }

# ---- Python 3.9+ (a real interpreter) ----
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && \
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
[ -n "$PY" ] || fail "Python 3.9+ not found. Install it from https://www.python.org/downloads/ (or: brew install python)."

# ---- Port must be free ----
if "$PY" - "$PORT" <<'EOF'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
busy = s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0
s.close()
sys.exit(0 if busy else 1)
EOF
then
  fail "Port $PORT is already in use (a backend may already be running). Close it, or run: bash start.sh 8080"
fi

# ---- Backend packages, in a private virtualenv (avoids "externally-managed-environment" on macOS) ----
if [ ! -x "$VENV/bin/python" ] && [ ! -x "$VENV/Scripts/python" ]; then
  echo "Creating Python environment (.venv)..."
  "$PY" -m venv "$VENV" || fail "Could not create the virtual environment."
fi
if [ -x "$VENV/bin/python" ]; then VPY="$VENV/bin/python"; else VPY="$VENV/Scripts/python"; fi

if ! "$VPY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing backend packages (internet needed the first time)..."
  "$VPY" -m pip install --quiet -r "$ROOT/backend/requirements.txt" || fail "Could not install the backend packages."
fi

# ---- Frontend: build it so the backend can serve it (needs Node.js) ----
if command -v npm >/dev/null 2>&1; then
  if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "Installing frontend packages (internet needed the first time)..."
    (cd "$ROOT/frontend" && npm install) || echo "[WARNING] npm install failed."
  fi
  echo "Building the frontend..."
  # "/" = same origin: the app calls whatever address it was opened from.
  (cd "$ROOT/frontend" && VITE_API_BASE=/ npm run build) \
    || echo "[WARNING] Frontend build failed - using the previous build if there is one."
else
  echo "[NOTE] Node.js not found - using the existing frontend build."
fi

[ -f "$ROOT/frontend/dist/index.html" ] || fail "No frontend build found. Install Node.js from https://nodejs.org and run this again."

# ---- Addresses other devices can use ----
LAN_IP="$("$VPY" - <<'EOF' 2>/dev/null
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("10.255.255.255", 1))   # no packet is sent; this only picks the outgoing interface
    print(s.getsockname()[0])
except Exception:
    pass
finally:
    s.close()
EOF
)"

echo
echo "================================================================"
echo " CHRONOS is starting."
echo
echo " On this computer:                     http://localhost:$PORT/"
if [ -n "$LAN_IP" ]; then
  echo " LAN Party (other devices, same network):  http://$LAN_IP:$PORT/"
fi
echo
echo " If another device cannot connect: allow incoming connections when macOS asks,"
echo " or check System Settings > Network > Firewall."
echo " To stop: press Ctrl+C in this window."
echo "================================================================"
echo

# ---- Open the browser a moment after the server is up ----
if [ -z "${NO_BROWSER:-}" ]; then
  (
    sleep 4
    if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT/"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT/"
    fi
  ) >/dev/null 2>&1 &
fi

cd "$ROOT/backend" && exec "$VPY" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
