"""
Project Chronos: end-to-end API integration tests (login -> Round 1 -> Round 2 ->
Lobby -> Round 3 -> completion, plus admin and security checks).

Run from the project root:

    pip install -r backend/requirements-dev.txt
    python -m unittest backend.tests.test_integration -v

Every test runs against a throw-away SQLite file (CHRONOS_DB_PATH). The real event
database is never opened.
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_TMP = tempfile.mkdtemp(prefix="chronos_test_")
os.environ["CHRONOS_DB_PATH"] = str(Path(_TMP) / "chronos_test.db")
os.environ["CHRONOS_ADMIN_PASSWORD"] = "test-admin-password-not-real"
os.environ["GEMINI_API_KEY"] = ""          # force the built-in fallback replies
os.environ["GROQ_API_KEYS"] = ""
os.environ["CHRONOS_AI_DISABLED"] = "1"    # never reach a real provider, whatever .env holds
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402

DB = os.environ["CHRONOS_DB_PATH"]
ADMIN_PASSWORD = os.environ["CHRONOS_ADMIN_PASSWORD"]


def db(sql, params=()):
    connection = sqlite3.connect(DB)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(sql, params).fetchall()
        connection.commit()
        return rows
    finally:
        connection.close()


class Player:
    """One logged-in test team."""

    def __init__(self, client, name, prn1, prn2):
        self.client = client
        res = client.post("/api/auth/login", json={
            "team_name": name, "member_1_name": "Test One", "member_2_name": "Test Two",
            "member_1_prn": prn1, "member_2_prn": prn2,
        })
        assert res.status_code == 200, res.text
        self.login = res.json()
        self.id = self.login["team_id"]
        self.token = self.login["session_token"]

    @property
    def headers(self):
        return {"X-Team-Token": self.token}

    def get(self, path, **params):
        return self.client.get(path, params={"team_id": self.id, **params}, headers=self.headers)

    def post(self, path, body=None, **query):
        if body is None:                      # Round 1 style: team_id travels in the query
            query = {"team_id": self.id, **query}
        return self.client.post(path, params=query, json=body, headers=self.headers)


def play_round1(p):
    """Answer every assigned Round 1 item (using the stored truth) and finish."""
    items = p.get("/api/round1/items")
    assert items.status_code == 200, items.text
    data = items.json()
    rows = data
    assert isinstance(rows, list) and len(rows) == 25, f"unexpected Round 1 items: {str(data)[:200]}"
    truth = {r["item_id"]: r["correct_era"] for r in db("SELECT item_id, correct_era FROM round1_items")}
    for row in rows:
        item_id = row["id"]
        res = p.post("/api/round1/submit", item_id=item_id, answer=truth[item_id])
        assert res.status_code == 200, res.text
    done = p.post("/api/round1/finish")
    assert done.status_code == 200, done.text
    return done.json()


def to_lobby_via_completion(p):
    play_round1(p)
    assert p.post("/api/round2/start", {"team_id": p.id}).status_code == 200
    assert p.post("/api/round2/complete", {"team_id": p.id}).status_code == 200


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._ctx = TestClient(app)
        cls.client = cls._ctx.__enter__()  # runs the startup (schema + seeds)

    @classmethod
    def tearDownClass(cls):
        cls._ctx.__exit__(None, None, None)

    def player(self, label):
        n = len(db("SELECT id FROM teams")) + 1
        return Player(self.client, f"{label}-{n}", f"24{n:09d}", f"25{n:09d}")

    # ------------------------------------------------------------- login / sessions
    def test_01_login_and_session_token(self):
        p = self.player("login")
        self.assertTrue(p.token)
        again = self.client.post("/api/auth/login", json={
            "team_name": p.login["team_name"], "member_1_name": "x", "member_2_name": "y",
            "member_1_prn": p.login["member_2_prn"], "member_2_prn": p.login["member_1_prn"],
        })
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["session_token"], p.token)  # returning team keeps its token

        wrong = self.client.post("/api/auth/login", json={
            "team_name": p.login["team_name"], "member_1_name": "x", "member_2_name": "y",
            "member_1_prn": "26000000001", "member_2_prn": "23000000002",
        })
        self.assertEqual(wrong.status_code, 409)

        self.assertEqual(self.client.get("/api/auth/session", params={"team_id": p.id}).status_code, 401)
        self.assertEqual(p.get("/api/auth/session").status_code, 200)

    def test_02_team_isolation(self):
        a, b = self.player("iso-a"), self.player("iso-b")
        bare = self.client.get("/api/round1/status", params={"team_id": a.id})
        self.assertEqual(bare.status_code, 401)
        # Team B's valid token must not open team A's data, in every round.
        for path in ("/api/round1/status", "/api/round2/progress", "/api/round3/availability",
                     "/api/round3/verdict", "/api/round3/scenario"):
            res = self.client.get(path, params={"team_id": a.id}, headers=b.headers)
            self.assertEqual(res.status_code, 401, path)
        res = self.client.post("/api/round3/start", json={"team_id": a.id}, headers=b.headers)
        self.assertEqual(res.status_code, 401)
        # Own id in the query, someone else's in the body: must not act on the other team.
        for path in ("/api/round3/start", "/api/transition/start", "/api/transition/stop"):
            res = self.client.post(path, params={"team_id": b.id}, json={"team_id": a.id}, headers=b.headers)
            self.assertEqual(res.status_code, 400, path)
        # Absurd ids are rejected cleanly, never a 500.
        res = self.client.get("/api/round1/status", params={"team_id": 10 ** 30}, headers=b.headers)
        self.assertEqual(res.status_code, 401)

    # --------------------------------------------------------------------- Round 1
    def test_03_round1_still_works(self):
        p = self.player("r1")
        status = p.get("/api/round1/status")
        self.assertEqual(status.status_code, 200)
        done = play_round1(p)
        self.assertNotIn("error", done, done)
        state = p.get("/api/auth/session").json()["current_state"]
        self.assertEqual(state.replace("_", ""), "ROUND1COMPLETED")

    # --------------------------------------------------------------------- Round 2
    def test_04_round2_investigation_only_and_lobby(self):
        p = self.player("r2")
        play_round1(p)
        start = p.post("/api/round2/start", {"team_id": p.id})
        self.assertEqual(start.status_code, 200, start.text)
        self.assertEqual(start.json()["state"], "ROUND_2_ACTIVE")

        files = p.get("/api/round2/files").json()
        self.assertEqual(len(files), 5)
        self.assertEqual({f['filename'] for f in files},
                         {'system_changes.log', 'login_records.log', 'security_keys.log',
                          'incident_report.txt', 'README.md'})
        opened = p.get(f"/api/round2/files/{files[0]['file_id']}")
        self.assertEqual(opened.status_code, 200)
        self.assertTrue(opened.json()["content_text"])
        # The suspect list is not served any more (Round 2 shows a timeline-event feed instead).
        self.assertEqual(p.get("/api/round2/suspects").status_code, 404)

        chat = p.post("/api/round2/chat", {"team_id": p.id, "message": "Who did it?"})
        self.assertEqual(chat.status_code, 200, chat.text)
        self.assertTrue(chat.json()["reply"])

        # No culprit-submission mechanic any more.
        self.assertIn(p.post("/api/round2/submit", {"team_id": p.id, "suspect": "x"}).status_code, (404, 405))

        # Round 3 is closed while Round 2 is active.
        early = p.post("/api/round3/start", {"team_id": p.id})
        self.assertEqual(early.status_code, 409)
        self.assertFalse(p.get("/api/round3/availability").json()["eligible"])

        done = p.post("/api/round2/complete", {"team_id": p.id})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json()["state"], "ROUND_2_COMPLETED")
        self.assertTrue(done.json()["completed"])
        again = p.post("/api/round2/complete", {"team_id": p.id})
        self.assertEqual(again.status_code, 200)  # idempotent

        # Completing Round 2 needed no score, and none was invented.
        self.assertEqual(db("SELECT COUNT(*) c FROM round2_submissions")[0]["c"], 0)

    def test_05_round2_timeout_path_reaches_the_lobby(self):
        p = self.player("timeout")
        play_round1(p)
        self.assertEqual(p.post("/api/round2/start", {"team_id": p.id}).status_code, 200)
        long_ago = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(timespec="seconds")
        db("UPDATE teams SET round2_started_at = ? WHERE id = ?", (long_ago, p.id))

        # Only the server clock says time is up: the state must flip on its own.
        availability = p.get("/api/round3/availability").json()
        self.assertTrue(availability["eligible"], availability)
        progress = p.get("/api/round2/progress").json()
        self.assertEqual(progress["state"], "TIMEOUT")
        self.assertTrue(progress["completed"])
        self.assertIsNotNone(db("SELECT round2_completed_at c FROM teams WHERE id=?", (p.id,))[0]["c"])

        start = p.post("/api/round3/start", {"team_id": p.id})
        self.assertEqual(start.status_code, 200, start.text)

    # --------------------------------------------------------------------- Round 3
    def test_06_round3_flow_and_evidence_rules(self):
        p = self.player("r3")
        to_lobby_via_completion(p)

        # Round 3 never starts by itself: the scenario is closed until the button.
        before = p.get("/api/round3/scenario")
        self.assertEqual(before.status_code, 409)
        self.assertEqual(p.get("/api/auth/session").json()["current_state"], "ROUND_2_COMPLETED")
        self.assertTrue(p.get("/api/round3/availability").json()["eligible"])

        start = p.post("/api/round3/start", {"team_id": p.id})
        self.assertEqual(start.status_code, 200, start.text)
        body = start.json()
        # Back to the Lobby from Round 3: Round 2 still reads as over, and START ROUND 3 is idempotent.
        progress = p.get("/api/round2/progress").json()
        self.assertTrue(progress["completed"])
        self.assertEqual(p.post("/api/round2/start", {"team_id": p.id}).status_code, 200)
        self.assertTrue(p.post("/api/round3/start", {"team_id": p.id}).json()["scenario"])
        self.assertEqual(body["team_state"], "ROUND_3_ACTIVE")
        blob = json.dumps(body).lower()
        for secret in ("culprit_candidate_id", "valid_evidence_ids", "narrative_summary"):
            self.assertNotIn(secret, blob)
        scenario = body["scenario"]
        self.assertEqual({c["id"] for c in scenario["candidates"]}, {"alpha", "beta", "gamma"})
        evidence = [e["id"] for e in scenario["evidence_archive"]]
        self.assertGreaterEqual(len(evidence), 4)

        # Idempotent start / read-only scenario.
        self.assertEqual(p.post("/api/round3/start", {"team_id": p.id}).status_code, 200)
        self.assertEqual(p.get("/api/round3/scenario").status_code, 200)

        # Verdict is closed before the decision.
        self.assertEqual(p.get("/api/round3/verdict").status_code, 409)

        submit = lambda cand, ev: p.post("/api/round3/submit", {
            "team_id": p.id, "selected_candidate_id": cand, "selected_evidence_ids": ev})

        self.assertEqual(submit("alpha", []).status_code, 422)             # no evidence
        self.assertEqual(submit("alpha", evidence[:1]).status_code, 422)   # one item
        self.assertEqual(submit("alpha", [evidence[0], evidence[0]]).status_code, 422)  # duplicates count once
        self.assertEqual(submit("mallory", evidence[:2]).status_code, 422)  # not a candidate
        self.assertEqual(submit("alpha", [evidence[0], "ev_made_up"]).status_code, 422)
        self.assertEqual(submit("", evidence[:2]).status_code, 422)
        bad = p.post("/api/round3/submit", {"team_id": p.id, "selected_candidate_id": "alpha",
                                            "selected_evidence_ids": "not-a-list"})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(db("SELECT COUNT(*) c FROM round3_submissions WHERE team_id=?", (p.id,))[0]["c"], 0)

        ok = submit("beta", evidence[:2])
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(ok.json()["submitted"])
        self.assertNotIn("is_correct", ok.json())
        self.assertNotIn("points", json.dumps(ok.json()).lower())

        # A second attempt cannot change the first result.
        first = db("SELECT * FROM round3_submissions WHERE team_id=?", (p.id,))[0]
        second = submit("gamma", evidence[:3])
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.json()["already_submitted"])
        after = db("SELECT * FROM round3_submissions WHERE team_id=?", (p.id,))
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["selected_candidate_id"], first["selected_candidate_id"])
        self.assertEqual(db("SELECT COUNT(*) c FROM submissions WHERE team_id=? AND round=3", (p.id,))[0]["c"], 1)

        self.assertEqual(p.get("/api/auth/session").json()["current_state"], "COMPLETED")
        verdict = p.get("/api/round3/verdict")
        self.assertEqual(verdict.status_code, 200)
        v = verdict.json()
        self.assertEqual(v["submission"]["selected_candidate_id"], "beta")
        self.assertTrue(v["verdict_details"]["narrative_summary"])
        self.assertNotIn("is_correct", json.dumps(v))
        self.assertNotIn("score", json.dumps(v).lower())

        # Completed teams that press the button again just get their locked state.
        again = p.post("/api/round3/start", {"team_id": p.id})
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.json()["is_submitted"])

    def test_07_round3_answer_isolation_and_no_debug_endpoint(self):
        a, b = self.player("ans-a"), self.player("ans-b")
        to_lobby_via_completion(a)
        to_lobby_via_completion(b)
        a.post("/api/round3/start", {"team_id": a.id})
        # b has not started: b's token cannot read a's scenario, and no catalogue exists.
        self.assertEqual(self.client.get("/api/round3/scenario", params={"team_id": a.id},
                                         headers=b.headers).status_code, 401)
        for path in ("/api/round3/debug-cases", "/api/round3/cases"):
            self.assertEqual(a.get(path).status_code, 404)

    # --------------------------------------------------------------------- admin
    def test_08_admin_protection_and_leaderboard(self):
        for path in ("/api/admin/leaderboard", "/api/admin/export-csv", "/api/admin/logs",
                     "/api/admin/session", "/api/admin/export/csv/teams"):
            res = self.client.get(path)
            self.assertIn(res.status_code, (401, 404), path)
        # A team's own token is not an admin credential.
        t = self.player("notadmin")
        self.assertEqual(self.client.get("/api/admin/leaderboard", headers=t.headers).status_code, 401)
        self.assertEqual(self.client.get("/api/admin/leaderboard",
                                         headers={"Authorization": "Bearer forged.token"}).status_code, 401)
        # No built-in default password.
        for guess in ("admin", "chronos2140", ""):
            self.assertEqual(self.client.post("/api/admin/login", json={"password": guess or "x"}).status_code, 401)

        login = self.client.post("/api/admin/login", json={"password": ADMIN_PASSWORD})
        self.assertEqual(login.status_code, 200)
        auth = {"Authorization": f"Bearer {login.json()['token']}"}

        # Finish a whole game so the board has a recorded Round 1 and Round 3.
        p = self.player("board")
        to_lobby_via_completion(p)
        start = p.post("/api/round3/start", {"team_id": p.id}).json()
        ev = [e["id"] for e in start["scenario"]["evidence_archive"]][:2]
        p.post("/api/round3/submit", {"team_id": p.id, "selected_candidate_id": "alpha",
                                      "selected_evidence_ids": ev})

        before = [dict(r) for r in db("SELECT * FROM teams ORDER BY id")]
        board = self.client.get("/api/admin/leaderboard", headers=auth)
        self.assertEqual(board.status_code, 200)
        self.client.get("/api/admin/leaderboard", headers=auth)
        after = [dict(r) for r in db("SELECT * FROM teams ORDER BY id")]
        self.assertEqual(before, after, "a leaderboard GET must not modify any team row")

        rows = {r["team_id"]: r for r in board.json()}
        mine = rows[p.id]
        # Round 2 was played with no questions asked: the recorded deduction is 0, so 20 remain.
        self.assertEqual(mine["round2_score"], 20.0)
        self.assertEqual(mine["round2_source"], "ai_deductions")
        self.assertFalse(mine["round2_provisional"])               # Round 2 is over
        self.assertIsNotNone(mine["round1_score"])
        self.assertIsNotNone(mine["round3_score"])
        self.assertTrue(mine["total_complete"])
        self.assertEqual(mine["total_score"],
                         mine["round1_score"] + mine["round2_score"] + mine["round3_score"])
        # A team that never reached Round 2 has an unknown (None) Round 2 score, not 0.
        waiting = self.player("never-r2")
        row = [r for r in self.client.get("/api/admin/leaderboard", headers=auth).json()
               if r["team_id"] == waiting.id][0]
        self.assertIsNone(row["round2_score"])
        self.assertIsNone(row["total_score"])
        self.assertNotIn("culprit", json.dumps(board.json()).lower())
        ranks = [r["rank"] for r in board.json()]
        self.assertEqual(ranks, sorted(ranks))

        csv_res = self.client.get("/api/admin/export-csv", headers=auth)
        self.assertEqual(csv_res.status_code, 200)
        self.assertIn("text/csv", csv_res.headers["content-type"])
        self.assertNotIn("culprit", csv_res.text.lower())

    def test_09_admin_disabled_without_password(self):
        from backend.app import config

        saved = os.environ.pop("CHRONOS_ADMIN_PASSWORD")
        saved_files, config._ENV_FILES = config._ENV_FILES, ()   # ignore a real .env on this machine
        try:
            self.assertEqual(self.client.post("/api/admin/login", json={"password": saved}).status_code, 503)
            self.assertEqual(self.client.get("/api/admin/leaderboard").status_code, 503)
        finally:
            config._ENV_FILES = saved_files
            os.environ["CHRONOS_ADMIN_PASSWORD"] = saved

    # ---------------------------------------------------------------- migrations
    def test_10_legacy_round3_table_migrates_idempotently(self):
        from backend.app.services import round3_service

        path = Path(_TMP) / "legacy.db"
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE round3_team_cases (
                id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER NOT NULL, case_id TEXT NOT NULL,
                status TEXT DEFAULT 'PENDING', valid_evidence_ids TEXT NOT NULL,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            INSERT INTO round3_team_cases (team_id, case_id, valid_evidence_ids) VALUES (7, 'CASE-01', '[]');
        """)
        round3_service.ensure_tables(conn)
        round3_service.ensure_tables(conn)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(round3_team_cases)")}
        self.assertTrue({"case_data", "culprit_candidate_id"} <= cols)
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM round3_team_cases").fetchone()["c"], 1)
        conn.close()

    def test_11_startup_is_repeatable(self):
        from backend.app.database.schema import create_tables
        from backend.app.services.round2_service import init_round2
        from backend.app.services.round3_service import init_round3

        before = db("SELECT COUNT(*) c FROM teams")[0]["c"]
        for _ in range(2):
            create_tables()
            init_round2()
            init_round3()
        self.assertEqual(db("SELECT COUNT(*) c FROM teams")[0]["c"], before)

    # ------------------------------------------------------- Round 2 question deductions
    def _started_r2(self, label):
        p = self.player(label)
        play_round1(p)
        self.assertEqual(p.post("/api/round2/start", {"team_id": p.id}).status_code, 200)
        return p

    def _ask(self, p, text, request_id=None):
        body = {"team_id": p.id, "message": text}
        if request_id:
            body["request_id"] = request_id
        return p.post("/api/round2/chat", body)

    def _ledger(self, p):
        return db("SELECT question_number, points_deducted FROM round2_chat_messages "
                  "WHERE team_id = ? ORDER BY question_number", (str(p.id),))

    def _board_row(self, auth, p):
        rows = self.client.get("/api/admin/leaderboard", headers=auth).json()
        return [r for r in rows if r["team_id"] == p.id][0]

    def _admin(self):
        res = self.client.post("/api/admin/login", json={"password": ADMIN_PASSWORD})
        return {"Authorization": f"Bearer {res.json()['token']}"}

    def test_12_question_deductions_5_5_10_and_limit(self):
        p = self._started_r2("ded")
        auth = self._admin()
        self.assertEqual(self._board_row(auth, p)["round2_score"], 20.0)   # started, nothing asked
        self.assertTrue(self._board_row(auth, p)["round2_provisional"])

        expected = [(5, 15.0), (5, 10.0), (10, 0.0)]
        for n, (cost, left) in enumerate(expected, start=1):
            res = self._ask(p, f"distinct question number {n}")
            self.assertEqual(res.status_code, 200, res.text)
            body = res.json()
            self.assertEqual(body["points_deducted"], cost)
            self.assertTrue(body["charged_now"])
            self.assertEqual(body["progress"]["ai"]["points_remaining"], left)
            self.assertEqual(self._board_row(auth, p)["round2_score"], left)

        # A fourth question is refused and costs nothing.
        self.assertEqual(self._ask(p, "one more please").status_code, 403)
        self.assertEqual([r["points_deducted"] for r in self._ledger(p)], [5, 5, 10])
        stored = db("SELECT round2_score FROM teams WHERE id = ?", (p.id,))[0]["round2_score"]
        self.assertEqual(stored, 0)

    def test_13_duplicates_retries_and_reloads_charge_once(self):
        p = self._started_r2("dup")
        first = self._ask(p, "What does the Alpha log show?", request_id="req-1")
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.json()["charged_now"])
        reply = first.json()["reply"]

        # same request id (client retry), same text (double click / re-submit), other casing
        for text, rid in (("What does the Alpha log show?", "req-1"),
                          ("What does the Alpha log show?", None),
                          ("  what DOES the alpha   log show? ", "req-other"),
                          ("a completely different text", "req-1")):
            again = self._ask(p, text, request_id=rid)
            self.assertEqual(again.status_code, 200, again.text)
            self.assertTrue(again.json()["duplicate"])
            self.assertFalse(again.json()["charged_now"])
            self.assertEqual(again.json()["reply"], reply)

        # a page reload only reads: conversation + progress, no charge
        p.get("/api/round2/conversation")
        p.get("/api/round2/progress")
        p.post("/api/round2/start", {"team_id": p.id})
        self.assertEqual([r["points_deducted"] for r in self._ledger(p)], [5])
        self.assertEqual(p.get("/api/round2/progress").json()["ai"]["points_remaining"], 15)

    def test_14_unanswered_question_is_not_charged_twice(self):
        p = self._started_r2("crash")
        self.assertEqual(self._ask(p, "first one").status_code, 200)
        # simulate a server stop after the charge but before the answer was stored
        db("UPDATE round2_chat_messages SET ai_response = '' WHERE team_id = ? AND question_number = 1",
           (str(p.id),))
        retry = self._ask(p, "first one")
        self.assertEqual(retry.status_code, 200)
        self.assertFalse(retry.json()["charged_now"])
        self.assertTrue(retry.json()["reply"])
        self.assertEqual([r["points_deducted"] for r in self._ledger(p)], [5])

    def test_15_unrelated_actions_never_deduct(self):
        p = self._started_r2("free")
        for f in p.get("/api/round2/files").json():
            p.get(f"/api/round2/files/{f['file_id']}")
        p.get("/api/round2/suspects")
        p.get("/api/round2/progress")
        p.get("/api/round2/conversation")
        self.assertEqual(p.post("/api/round2/complete", {"team_id": p.id}).status_code, 200)
        p.post("/api/round2/complete", {"team_id": p.id})
        self.assertEqual(self._ledger(p), [])
        row = self._board_row(self._admin(), p)
        self.assertEqual(row["round2_score"], 20.0)
        self.assertEqual(row["round2_points_deducted"], 0.0)

    def test_16_leaderboard_totals_ranking_and_read_only(self):
        auth = self._admin()
        careful, heavy = self._started_r2("careful"), self._started_r2("heavy")
        self._ask(heavy, "heavy question one")
        self._ask(heavy, "heavy question two")
        for p in (careful, heavy):
            p.post("/api/round2/complete", {"team_id": p.id})

        # Round 1 and Round 3 are independent of the deductions.
        r1_before = {p.id: db("SELECT round1_score FROM teams WHERE id=?", (p.id,))[0][0] for p in (careful, heavy)}
        snapshot = [dict(r) for r in db("SELECT * FROM teams ORDER BY id")]
        board = self.client.get("/api/admin/leaderboard", headers=auth).json()
        self.client.get("/api/admin/leaderboard", headers=auth)
        self.assertEqual(snapshot, [dict(r) for r in db("SELECT * FROM teams ORDER BY id")])

        rows = {r["team_id"]: r for r in board}
        self.assertEqual(rows[careful.id]["round2_score"], 20.0)
        self.assertEqual(rows[heavy.id]["round2_score"], 10.0)
        self.assertEqual(rows[heavy.id]["round1_score"], float(r1_before[heavy.id]))
        for r in (rows[careful.id], rows[heavy.id]):
            self.assertEqual(r["total_score"], r["round1_score"] + r["round2_score"])
            self.assertFalse(r["total_complete"])                  # Round 3 not played
        # identical Round 1 (same answers), so the team that asked fewer questions ranks higher
        self.assertLess(rows[careful.id]["rank"], rows[heavy.id]["rank"])

        # Round 3 afterwards: +10/0 only, and the stored total follows the three rounds.
        start = heavy.post("/api/round3/start", {"team_id": heavy.id}).json()
        ev = [e["id"] for e in start["scenario"]["evidence_archive"]][:2]
        heavy.post("/api/round3/submit", {"team_id": heavy.id, "selected_candidate_id": "alpha",
                                          "selected_evidence_ids": ev})
        row = self._board_row(auth, heavy)
        self.assertEqual(row["round2_score"], 10.0)                # unchanged by Round 3
        self.assertEqual(row["total_score"], row["round1_score"] + 10.0 + row["round3_score"])
        self.assertTrue(row["total_complete"])
        stored = db("SELECT round1_score, round2_score, round3_score, total_score FROM teams WHERE id=?",
                    (heavy.id,))[0]
        self.assertEqual(stored["round2_score"], 10)
        self.assertEqual(stored["total_score"], stored["round1_score"] + stored["round2_score"] + stored["round3_score"])

    def test_16b_round3_correct_lock_in_is_exactly_10(self):
        """Round 3: the correct culprit is worth +10, wrong is 0, and no other factor
        (evidence count, which candidate letter, timing) changes it."""
        results = []
        for name, wrong, extra in (("r3a", False, 0), ("r3b", False, 2), ("r3c", True, 2)):
            p = self.player(name)
            to_lobby_via_completion(p)
            start = p.post("/api/round3/start", {"team_id": p.id}).json()
            ev = [e["id"] for e in start["scenario"]["evidence_archive"]]
            culprit = db("SELECT culprit_candidate_id FROM round3_team_cases WHERE team_id=?", (p.id,))[0][
                "culprit_candidate_id"]
            pick = next(c for c in ("alpha", "beta", "gamma") if (c != culprit) == wrong)
            res = p.post("/api/round3/submit", {"team_id": p.id, "selected_candidate_id": pick,
                                                "selected_evidence_ids": ev[:2 + extra]})
            self.assertEqual(res.status_code, 200, res.text)
            row = db("SELECT round1_score, round2_score, round3_score, total_score FROM teams WHERE id=?", (p.id,))[0]
            results.append((wrong, row["round3_score"]))
            self.assertEqual(row["total_score"], row["round1_score"] + row["round2_score"] + row["round3_score"])
        self.assertEqual([r for _, r in results], [10, 10, 0])

    def test_16c_one_time_admin_passwords(self):
        """Master password never expires; temp passwords work exactly once and are listed used."""
        master = self._admin()
        c = self.client
        post = lambda pw: c.post("/api/admin/login", json={"password": pw})

        # only the master password can manage passwords
        self.assertEqual(c.get("/api/admin/passwords").status_code, 401)
        res = c.post("/api/admin/passwords", json={"passwords": ["otp-one", "otp-two", "otp-one", "ab",
                                                                  ADMIN_PASSWORD], "generate": 2},
                     headers=master)
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(sorted(a for a in body["added"] if a.startswith("otp")), ["otp-one", "otp-two"])
        self.assertEqual(len(body["added"]), 4)                 # 2 typed + 2 generated
        self.assertEqual(len(body["skipped"]), 3)               # duplicate, too short, master
        listed = c.get("/api/admin/passwords", headers=master).json()
        self.assertEqual(len(listed["unused"]), 4)
        self.assertEqual(listed["used"], [])

        # first login consumes it, second login with the same one fails
        first = post("otp-one")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["role"], "temp")
        self.assertEqual(post("otp-one").status_code, 401)
        temp = {"Authorization": "Bearer " + first.json()["token"]}

        # a one-time session sees the leaderboard but cannot manage passwords
        self.assertEqual(c.get("/api/admin/leaderboard", headers=temp).status_code, 200)
        self.assertEqual(c.get("/api/admin/passwords", headers=temp).status_code, 403)
        self.assertEqual(c.post("/api/admin/passwords", json={"generate": 1}, headers=temp).status_code, 403)

        listed = c.get("/api/admin/passwords", headers=master).json()
        self.assertEqual([p["password"] for p in listed["used"]], ["otp-one"])
        self.assertNotIn("otp-one", [p["password"] for p in listed["unused"]])

        # a used password cannot be added again; unused ones can be revoked
        again = c.post("/api/admin/passwords", json={"passwords": ["otp-one"]}, headers=master).json()
        self.assertEqual(again["added"], [])
        two = next(p for p in listed["unused"] if p["password"] == "otp-two")
        self.assertEqual(c.delete(f"/api/admin/passwords/{two['id']}", headers=master).status_code, 200)
        self.assertEqual(post("otp-two").status_code, 401)

        # master keeps working any number of times
        self.assertEqual(post(ADMIN_PASSWORD).status_code, 200)
        self.assertEqual(post(ADMIN_PASSWORD).status_code, 200)

    def test_16d_round3_shows_own_round2_questions_without_points(self):
        a, b = self._started_r2("inq_a"), self._started_r2("inq_b")
        self.assertEqual(self._ask(a, "which terminal changed first?").status_code, 200)
        for p in (a, b):
            self.assertEqual(p.post("/api/round2/complete", {"team_id": p.id}).status_code, 200)
        ra = a.post("/api/round3/start", {"team_id": a.id}).json()
        rb = b.post("/api/round3/start", {"team_id": b.id}).json()
        msgs = ra["round2_investigation"]["chat_messages"]
        self.assertEqual([m["question_number"] for m in msgs], [1])
        self.assertEqual(msgs[0]["user_prompt"], "which terminal changed first?")
        self.assertNotIn("points", json.dumps(ra["round2_investigation"]).lower())
        self.assertEqual(rb["round2_investigation"]["chat_messages"], [])   # only own questions
        again = a.get("/api/round3/scenario").json()
        self.assertEqual(len(again["round2_investigation"]["chat_messages"]), 1)

    def test_16e_transition_progress_survives_a_reload(self):
        p = self.player("resume")
        play_round1(p)                                    # Round 1 finished, transition round not opened
        prog = p.get(f"/api/transition/progress?team_id={p.id}").json()
        self.assertEqual(prog, {"eligible": True, "clue_assigned": False, "started": False,
                                "stopped": False, "completed": False})
        # progress never allocates a clue
        self.assertIsNone(db("SELECT transition_clue_id FROM teams WHERE id=?", (p.id,))[0]["transition_clue_id"])

        state = p.get(f"/api/transition/state?team_id={p.id}").json()      # opens the briefing screen
        self.assertFalse(state["started"])
        self.assertTrue(p.get(f"/api/transition/progress?team_id={p.id}").json()["clue_assigned"])

        started = p.post("/api/transition/start", {"team_id": p.id}).json()  # START STOPWATCH
        self.assertTrue(started["started"])
        self.assertTrue(started["started_at"])
        reload_state = p.get(f"/api/transition/state?team_id={p.id}").json()
        self.assertTrue(reload_state["started"])                            # reload -> passkey screen
        self.assertEqual(reload_state["clue_id"], state["clue_id"])
        self.assertEqual(reload_state["started_at"], started["started_at"])
        self.assertTrue(p.get(f"/api/transition/progress?team_id={p.id}").json()["started"])
        self.assertFalse(reload_state["stopped"])                           # still running after a reload
        self.assertIsNotNone(reload_state["elapsed_ms"])

        # END STOPWATCH: the duration is frozen on the server and a reload no longer counts
        stopped = p.post("/api/transition/stop", {"team_id": p.id}).json()
        self.assertTrue(stopped["stopped"])
        after = p.get(f"/api/transition/state?team_id={p.id}").json()
        self.assertTrue(after["stopped"])
        self.assertEqual(after["elapsed_ms"], stopped["elapsed_ms"])
        self.assertTrue(p.get(f"/api/transition/progress?team_id={p.id}").json()["stopped"])
        # another team cannot read this team's progress
        other = self.player("resume_other")
        res = self.client.get("/api/transition/progress", params={"team_id": p.id}, headers=other.headers)
        self.assertEqual(res.status_code, 401)

    def test_16f_tester_skip_shortcut(self):
        p = self.player("skipper")
        saved = os.environ.pop("CHRONOS_ENABLE_SKIP", None)
        admin = self._admin()
        switch = lambda on: self.client.post("/api/admin/dev-skip", json={"enabled": on}, headers=admin)
        try:
            # off: the route behaves as if it did not exist
            self.assertEqual(switch(False).json(), {"enabled": False})
            self.assertEqual(p.post("/api/dev/skip-round", {"team_id": p.id}).status_code, 404)
            # only the master admin can flip it; a team token cannot
            self.assertEqual(self.client.post("/api/admin/dev-skip", json={"enabled": True},
                                              headers=p.headers).status_code, 401)
            self.assertEqual(self.client.get("/api/admin/dev-skip", headers=admin).json(), {"enabled": False})
            self.assertEqual(switch(True).json(), {"enabled": True})
            # another team's token cannot skip this team
            other = self.player("skipper_other")
            res = self.client.post("/api/dev/skip-round", json={"team_id": p.id}, headers=other.headers)
            self.assertEqual(res.status_code, 401)

            seq = []
            for _ in range(5):
                res = p.post("/api/dev/skip-round", {"team_id": p.id})
                self.assertEqual(res.status_code, 200, res.text)
                seq.append(res.json()["skipped"])
            self.assertEqual(seq, ["round1", "transition", "round2", "round3", None])

            row = db("SELECT * FROM teams WHERE id = ?", (p.id,))[0]
            self.assertEqual(row["current_state"], "COMPLETED")
            for col in ("round1_score", "transition_score", "round2_score", "round3_score", "total_score"):
                self.assertEqual(row[col], 0, col)
            board = self._board_row(self._admin(), p)
            self.assertEqual((board["round1_score"], board["round2_score"], board["round3_score"],
                              board["total_score"]), (0.0, 0.0, 0.0, 0.0))
            self.assertEqual(p.get("/api/round3/verdict").status_code, 200)
            self.assertEqual(len(db("SELECT 1 FROM game_logs WHERE team_id = ? AND event_type = 'DEV_SKIP'",
                                    (p.id,))), 4)
            self.assertEqual(switch(False).json(), {"enabled": False})
            self.assertEqual(p.post("/api/dev/skip-round", {"team_id": p.id}).status_code, 404)
        finally:
            switch(False)
            if saved is not None:
                os.environ["CHRONOS_ENABLE_SKIP"] = saved

    def test_16g_admin_can_delete_a_team(self):
        keep, gone = self._started_r2("keep"), self._started_r2("gone")
        self.assertEqual(self._ask(gone, "which terminal changed first?").status_code, 200)
        admin = self._admin()
        # teams cannot delete; unknown team 404
        self.assertEqual(self.client.delete(f"/api/admin/teams/{gone.id}", headers=keep.headers).status_code, 401)
        self.assertEqual(self.client.delete("/api/admin/teams/999999", headers=admin).status_code, 404)

        res = self.client.delete(f"/api/admin/teams/{gone.id}", headers=admin)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["team_name"], gone.login["team_name"])
        for table in ("teams", "round1_team_items", "round1_submissions", "round2_team_cases",
                      "round2_chat_messages", "game_logs"):
            col = "id" if table == "teams" else "team_id"
            self.assertEqual(db(f"SELECT 1 FROM {table} WHERE {col} = ?", (gone.id,)), [], table)
        # the other team and the catalogues are untouched; the deleted team's token is dead
        self.assertEqual(len(db("SELECT 1 FROM teams WHERE id = ?", (keep.id,))), 1)
        self.assertGreater(len(db("SELECT 1 FROM round1_team_items WHERE team_id = ?", (keep.id,))), 0)
        self.assertGreater(db("SELECT COUNT(*) c FROM round2_cases")[0]["c"], 0)
        self.assertEqual(gone.get("/api/round2/progress").status_code, 401)
        ids = [r["team_id"] for r in self.client.get("/api/admin/leaderboard", headers=admin).json()]
        self.assertNotIn(gone.id, ids)
        self.assertIn(keep.id, ids)

    def test_17_admin_authorization_for_scores(self):
        p = self._started_r2("authz")
        self._ask(p, "authz question")
        self.assertEqual(self.client.get("/api/admin/leaderboard").status_code, 401)
        self.assertEqual(self.client.get("/api/admin/leaderboard", headers=p.headers).status_code, 401)
        self.assertEqual(self.client.get("/api/admin/export-csv").status_code, 401)
        csv_text = self.client.get("/api/admin/export-csv", headers=self._admin()).text
        self.assertIn("Round 2 AI Questions Used", csv_text)

    def test_18_other_teams_cannot_charge_a_team(self):
        a, b = self._started_r2("victim"), self._started_r2("attacker")
        res = self.client.post("/api/round2/chat", json={"team_id": a.id, "message": "x"}, headers=b.headers)
        self.assertEqual(res.status_code, 401)
        self.assertEqual(self._ledger(a), [])

    def test_19_stale_round1_calls_never_rewind_a_team(self):
        """An old tab / late auto-submit must not drag a team back to ROUND1_COMPLETED (and
        must not overwrite its Round 1 auth code or finish time)."""
        p = self.player("stale")
        play_round1(p)
        before = db("SELECT round1_auth_code, round1_completed_at FROM teams WHERE id=?", (p.id,))[0]
        self.assertEqual(p.post("/api/round2/start", {"team_id": p.id}).status_code, 200)
        state = db("SELECT current_state FROM teams WHERE id=?", (p.id,))[0]["current_state"]
        self.assertEqual(state, "ROUND_2_ACTIVE")

        again = p.post("/api/round1/finish")
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.json()["round1_completed"])
        late_answer = p.post("/api/round1/submit", item_id=1, answer="PAST")
        self.assertIn("error", late_answer.json())
        p.get("/api/round1/items")
        after = db("SELECT current_state, round1_auth_code, round1_completed_at FROM teams WHERE id=?", (p.id,))[0]
        self.assertEqual(after["current_state"], "ROUND_2_ACTIVE")
        self.assertEqual(after["round1_auth_code"], before["round1_auth_code"])
        self.assertEqual(after["round1_completed_at"], before["round1_completed_at"])
        self.assertTrue(p.get("/api/round1/status").json()["completed"])

    def test_20_login_validation_limits(self):
        def login(**kw):
            body = {"team_name": "Valid Limits", "member_1_name": "A", "member_2_name": "B",
                    "member_1_prn": "24500000001", "member_2_prn": "25500000002"}
            body.update(kw)
            return self.client.post("/api/auth/login", json=body)

        self.assertEqual(login(member_2_prn="24500000001", team_name="Same Prn").status_code, 400)
        self.assertEqual(login(team_name="x" * 51).status_code, 400)
        self.assertEqual(login(member_1_name="y" * 51, team_name="Long Name").status_code, 400)
        first = login(team_name="Prn Owner", member_1_prn="24500000011", member_2_prn="25500000012")
        self.assertEqual(first.status_code, 200)
        # the same two players cannot register again under another name (Round 1 replay)
        dup = login(team_name="Prn Owner Again", member_1_prn="24500000011", member_2_prn="25500000099")
        self.assertEqual(dup.status_code, 409)
        self.assertIn("Prn Owner", dup.json()["detail"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
