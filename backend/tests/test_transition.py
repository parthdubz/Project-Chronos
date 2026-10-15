"""
Project Chronos — Transition Round test suite.
Runs against a throwaway database and a fake in-memory password sheet, so it never touches
the live chronos.db or the real Google Sheet.

Run:  python backend/tests/test_transition.py
"""

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="chronos_transition_"))
os.environ["CHRONOS_DB_PATH"] = str(_tmp / "test.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.database.schema import create_tables
from backend.app.database.connection import get_connection
from backend.app.services import transition_service as ts
from backend.app.services import sheet_passwords
from backend.app.services.sheet_passwords import PasswordServiceError
from backend.app.services.transition_service import TransitionService, TransitionError, zone_for_clue

# --- fake password sheet -----------------------------------------------------------------------
SHEET = {}          # zone -> {password: used?}
SHEET_DOWN = False


def reset_sheet():
    global SHEET_DOWN
    SHEET_DOWN = False
    for zone in ts.ZONES:
        SHEET[zone] = {f"{zone.upper()}A": False, f"{zone.upper()}B": False}


def fake_consume(zone, password, team_id=None, team_name=None):
    if SHEET_DOWN:
        raise PasswordServiceError("sheet down")
    used = SHEET[zone].get(password)
    if used is None or used:
        return False
    SHEET[zone][password] = True
    return True


ts.consume_password = fake_consume


def unused(zone):
    return sorted(p for p, used in SHEET[zone].items() if not used)


def team(team_id, state="ROUND1_COMPLETED", r1=40):
    conn = get_connection()
    conn.execute("DELETE FROM game_logs WHERE team_id = ?", (team_id,))
    conn.execute("DELETE FROM submissions WHERE team_id = ?", (team_id,))
    conn.execute("DELETE FROM teams WHERE id = ?", (team_id,))
    conn.execute(
        "INSERT INTO teams (id, team_name, member_1_name, member_2_name, current_state, round1_score) "
        "VALUES (?, ?, 'a', 'b', ?, ?)", (team_id, f"T{team_id}", state, r1))
    conn.commit()
    conn.close()


def wipe():
    conn = get_connection()
    conn.execute("DELETE FROM game_logs")
    conn.execute("DELETE FROM submissions")
    conn.execute("DELETE FROM teams")
    conn.commit()
    conn.close()


def clue_of(team_id):
    return TransitionService.get_state(team_id)["clue_id"]


def zone_of(team_id):
    return zone_for_clue(clue_of(team_id))


def expect_error(fn, status):
    try:
        fn()
    except TransitionError as err:
        assert err.status_code == status, (err.status_code, status)
        return
    raise AssertionError("expected TransitionError")


def score_of(team_id):
    conn = get_connection()
    row = conn.execute("SELECT transition_score, total_score, current_state FROM teams WHERE id = ?", (team_id,)).fetchone()
    conn.close()
    return row["transition_score"], row["total_score"], row["current_state"]


create_tables()
reset_sheet()

# --- allocation: pure picker ---------------------------------------------------------------
pick = ts.pick_clue_id
assert zone_for_clue(pick([])) == "past"
held = []
zones = []
for _ in range(6):
    c = pick(held)
    held.append((c, True))
    zones.append(zone_for_clue(c))
assert sorted(zones) == ["future", "future", "past", "past", "present", "present"], zones  # 2-2-2
assert len({c for c, _ in held}) == 6  # all different clues
for _ in range(6):  # second cycle: zones may repeat, still 2 each, still no clue shared
    held.append((pick(held), True))
second = [zone_for_clue(c) for c, _ in held[6:]]
assert sorted(second) == ["future", "future", "past", "past", "present", "present"], second
assert len({c for c, _ in held}) == 12
partial = [(0, True), (1, True)]  # past has its 2
assert zone_for_clue(pick(partial)) != "past"
many = []
for _ in range(30):
    many.append((pick(many), True))
assert len({c for c, _ in many}) == 30
print("ok allocator (2-2-2 cycles, unique clues)")

# --- allocation through the service: first-come, persisted -------------------------------------
wipe()
for i in range(1, 7):
    team(i)
got = {i: clue_of(i) for i in range(1, 7)}
assert len(set(got.values())) == 6
assert sorted(zone_for_clue(c) for c in got.values()) == ["future", "future", "past", "past", "present", "present"]
assert all(clue_of(i) == got[i] for i in range(1, 7))  # stable on repeat calls
team(7)
assert clue_of(7) is not None
print("ok persisted assignment")

# --- gating ------------------------------------------------------------------------------------
wipe()
team(1, state="ROUND1_ACTIVE")
assert TransitionService.get_state(1)["clue_id"] is None  # not eligible yet: nothing allocated
expect_error(lambda: TransitionService.start(1), 409)
expect_error(lambda: TransitionService.verify(1, "PASTA"), 409)
expect_error(lambda: TransitionService.get_state(999), 404)
print("ok gating")

# --- correct first time: 20 pts, password marked used, total updated ----------------------------
wipe()
team(1)
assert TransitionService.start(1)["status"] == "ACTIVE"
assert TransitionService.start(1)["status"] == "ACTIVE"  # idempotent
z = zone_of(1)
expect_error(lambda: TransitionService.verify(1, "   "), 400)
res = TransitionService.verify(1, f"  {z.lower()}a ")  # trimmed + case-insensitive
assert res["correct"] and res["completed"] and res["score"] == 20.0, res
assert unused(z) == [f"{z.upper()}B"], unused(z)
assert score_of(1) == (20.0, 60.0, "ROUND1_COMPLETED"), score_of(1)
again = TransitionService.verify(1, f"{z.upper()}B")  # no re-scoring after completion
assert again["completed"] and unused(z) == [f"{z.upper()}B"]
print("ok correct on 1st attempt")

# --- 1 wrong then correct: 15 ---------------------------------------------------------------
reset_sheet()
team(2)
TransitionService.start(2)
z = zone_of(2)
res = TransitionService.verify(2, "NOPE1234")
assert not res["correct"] and not res["completed"] and res["attempts_remaining"] == 2, res
assert unused(z) == [f"{z.upper()}A", f"{z.upper()}B"]  # wrong entry consumes nothing
res = TransitionService.verify(2, f"{z.upper()}A")
assert res["score"] == 15.0 and unused(z) == [f"{z.upper()}B"], res
print("ok wrong then correct = 15")

# --- an already-used password is wrong (another team cannot reuse it) -------------------------
reset_sheet()
team(3)
TransitionService.start(3)
z = zone_of(3)
SHEET[z][f"{z.upper()}A"] = True  # used by someone else
res = TransitionService.verify(3, f"{z.upper()}A")
assert not res["correct"] and res["attempts_remaining"] == 2
res = TransitionService.verify(3, f"{z.upper()}B")
assert res["correct"] and res["score"] == 15.0
print("ok used password rejected")

# --- two wrong then correct: 10 ---------------------------------------------------------------
reset_sheet()
team(4)
TransitionService.start(4)
z = zone_of(4)
TransitionService.verify(4, "BAD00001")
TransitionService.verify(4, "BAD00002")
res = TransitionService.verify(4, f"{z.upper()}A")
assert res["score"] == 10.0 and res["completed"], res
print("ok two wrong then correct = 10")

# --- three wrong: locked at 0, no more attempts, team may continue ----------------------------
reset_sheet()
team(5)
TransitionService.start(5)
z = zone_of(5)
r1 = TransitionService.verify(5, "BAD1")
r2 = TransitionService.verify(5, "BAD2")
r3 = TransitionService.verify(5, "BAD3")
assert (r1["completed"], r2["completed"], r3["completed"]) == (False, False, True)
assert r3["score"] == 0.0 and r3["locked"] and r3["attempts_remaining"] == 0, r3
assert score_of(5) == (0.0, 40.0, "ROUND1_COMPLETED")
late = TransitionService.verify(5, f"{z.upper()}A")  # locked: even the right password no longer counts
assert late["completed"] and score_of(5)[0] == 0.0 and f"{z.upper()}A" in unused(z)
print("ok three wrong = locked at 0")

# --- finished teams release their clue for reuse ------------------------------------------------
wipe()
reset_sheet()
for i in range(1, 7):
    team(i)
    TransitionService.start(i)
z1 = zone_of(1)
TransitionService.verify(1, f"{z1.upper()}A")  # team 1 finishes: its clue is no longer held
team(7)
c7 = clue_of(7)
others_held = {clue_of(i) for i in range(2, 7)}
assert c7 not in others_held, "a clue still held by an active team was handed out again"
print("ok no clue shared between active teams")

# --- sheet unreachable -> 503 and the attempt is NOT counted -----------------------------------
wipe()
reset_sheet()
team(9)
TransitionService.start(9)
z = zone_of(9)
SHEET_DOWN = True
expect_error(lambda: TransitionService.verify(9, f"{z.upper()}A"), 503)
state = TransitionService.get_state(9)
assert state["attempts_used"] == 0 and state["attempts_remaining"] == 3 and state["status"] == "ACTIVE", state
SHEET_DOWN = False
res = TransitionService.verify(9, f"{z.upper()}A")
assert res["correct"] and res["score"] == 20.0
print("ok sheet outage does not cost an attempt")


# --- stopwatch: running resumes after a reload, stopped stays frozen -----------------------------
import time as _time

wipe()
reset_sheet()
team(11)
st = TransitionService.get_state(11)
assert st["started"] is False and st["elapsed_ms"] is None and st["stopped"] is False
expect_error(lambda: TransitionService.stop(11), 409)  # nothing to stop yet
started = TransitionService.start(11)
assert started["started"] and not started["stopped"]
_time.sleep(1.2)
run1 = TransitionService.get_state(11)  # a "reload" while running
assert run1["started"] and not run1["stopped"] and run1["elapsed_ms"] >= 1000, run1
_time.sleep(0.4)
run2 = TransitionService.get_state(11)
assert run2["elapsed_ms"] > run1["elapsed_ms"], "a running stopwatch must keep counting"
assert TransitionService.start(11)["started_at"] == run1["started_at"]  # start is not restarted

stopped = TransitionService.stop(11)
assert stopped["stopped"] and stopped["stopped_at"], stopped
frozen = stopped["elapsed_ms"]
_time.sleep(1.1)
after = TransitionService.get_state(11)  # a "reload" after END STOPWATCH
assert after["stopped"] and after["elapsed_ms"] == frozen, (after["elapsed_ms"], frozen)
assert TransitionService.stop(11)["elapsed_ms"] == frozen  # stopping again changes nothing
assert TransitionService.progress(11)["stopped"] is True
print("ok stopwatch resumes while running and stays frozen once stopped")

# --- entering a password ends a stopwatch that was never stopped explicitly ---------------------
team(12)
TransitionService.start(12)
_time.sleep(0.6)
z = zone_of(12)
res = TransitionService.verify(12, f"{z.upper()}A")
assert res["correct"] and res["stopped"] and res["elapsed_ms"] is not None, res
frozen12 = res["elapsed_ms"]
_time.sleep(0.5)
assert TransitionService.get_state(12)["elapsed_ms"] == frozen12
print("ok verify freezes the stopwatch")


# --- real HTTP client against a local fake Apps Script (redirect + JSON) -----------------------
class FakeScript(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        # Like Apps Script: answer the POST with a redirect to the result.
        self.send_response(302)
        good = int(body["secret"] == "s3cret" and body["password"] == "GOOD")
        self.send_header("Location", f"/result?ok={good}")
        self.end_headers()

    def do_GET(self):
        payload = json.dumps({"ok": self.path.endswith("ok=1")}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)


server = HTTPServer(("127.0.0.1", 0), FakeScript)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["TRANSITION_SHEET_URL"] = f"http://127.0.0.1:{server.server_port}/exec"
os.environ["TRANSITION_SHEET_SECRET"] = "s3cret"
assert sheet_passwords.consume_password("past", "GOOD") is True
assert sheet_passwords.consume_password("past", "NOPE") is False
os.environ["TRANSITION_SHEET_URL"] = "http://127.0.0.1:9/exec"  # nothing listens here
try:
    sheet_passwords.consume_password("past", "GOOD")
    raise AssertionError("expected PasswordServiceError")
except PasswordServiceError:
    pass
os.environ.pop("TRANSITION_SHEET_URL")
try:
    sheet_passwords.consume_password("past", "GOOD")
    raise AssertionError("expected PasswordServiceError (not configured)")
except PasswordServiceError:
    pass
server.shutdown()
print("ok sheet client (redirect, wrong password, unreachable, not configured)")

print("\nALL TRANSITION TESTS PASSED")
