"""
Remote switch for KeyBlocker.exe (tools/KeyBlocker).

The host flips one switch in the admin portal (Key Blocker tab). Every KeyBlocker.exe on a
player laptop asks the server every couple of seconds "locked or unlocked?" and blocks / frees
the Windows keys and Tab accordingly. Each poll doubles as a heartbeat, so the host also sees
which laptops are online and whether they are really blocking.

State lives in memory on purpose: after a server restart the switch is OFF (keys free), so a
restart can never leave laptops locked. A change is also written to game_logs.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from typing import Any

from ..database.connection import get_connection

ONLINE_SECONDS = 10      # a laptop that has not asked for this long is shown as offline
FORGET_SECONDS = 3600    # ... and is dropped from the list after an hour
POLL_SECONDS = 2         # what the exe is told to use

_lock = threading.Lock()
_state: dict[str, Any] = {"locked": False, "changed_at": None}
_clients: dict[str, dict[str, Any]] = {}


def get_state() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def set_locked(locked: bool) -> dict[str, Any]:
    with _lock:
        _state["locked"] = bool(locked)
        _state["changed_at"] = datetime.now(timezone.utc).isoformat()
        snapshot = dict(_state)
    try:
        connection = get_connection()
        try:
            connection.execute(
                "INSERT INTO game_logs (team_id, event_type, event_data, created_at) VALUES (NULL, ?, ?, ?)",
                ("ADMIN_KEYBLOCKER", json.dumps({"locked": bool(locked)}), snapshot["changed_at"]),
            )
            connection.commit()
        finally:
            connection.close()
    except Exception:
        pass  # the switch itself must never fail because the log could not be written
    return snapshot


def heartbeat(name: str, ip: str, blocking: bool, version: str) -> None:
    name = (name or "").strip()[:60] or ip or "unknown"
    now = time.time()
    with _lock:
        _clients[name] = {
            "name": name,
            "ip": ip,
            "blocking": bool(blocking),
            "version": (version or "")[:20],
            "last_seen": now,
        }
        for key in [k for k, v in _clients.items() if now - v["last_seen"] > FORGET_SECONDS]:
            del _clients[key]


def clients() -> list[dict[str, Any]]:
    now = time.time()
    with _lock:
        rows = [dict(v) for v in _clients.values()]
    out = []
    for r in rows:
        age = now - r["last_seen"]
        out.append({
            "name": r["name"],
            "ip": r["ip"],
            "blocking": r["blocking"],
            "version": r["version"],
            "online": age <= ONLINE_SECONDS,
            "seconds_ago": int(age),
        })
    out.sort(key=lambda r: (not r["online"], r["name"].lower()))
    return out
