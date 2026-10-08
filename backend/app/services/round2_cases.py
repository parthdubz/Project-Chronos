"""
Round 2 cases: 24 different investigations, one assigned per team per game.

Case data lives in `round2_cases_all_24/R2-01 ... R2-24/` (case.json plus the
Alpha / Beta / Gamma text files). This module loads those folders into the
database on first use and decides which case a team plays.

Tables (names match the shared seed script `seed_round2_cases.py`):
  round2_cases          one row per case, holds the hidden culprit
  round2_case_files     Alpha / Beta / Gamma text for each case
  round2_case_suspects  the candidates of each case (3 or 4, whatever case.json lists)
  round2_team_cases     the case a team is playing right now (one row per team)
  round2_case_history   every case a team was ever given, so a new game never
                        repeats an old case until all 24 have been used

Assignment: a random case out of all 24, so nobody can predict which case a
team will get. The only rule is that a team that starts over never gets a case
it already played (until it has played all 24).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

# .../Round2_Test/backend/app/services/round2_cases.py -> .../Round2_Test
CASES_DIR = Path(__file__).resolve().parents[3] / "round2_cases_all_24"

_seeded = set()   # database files already loaded by this process
_PROJECT_NAMES = {"alpha": "Alpha", "beta": "Beta", "gamma": "Gamma"}
_TIMELINE_TAGS = {"alpha": "future", "beta": "present", "gamma": "past"}


def ensure_case_tables(connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS round2_cases (
            case_id    TEXT PRIMARY KEY,
            case_code  TEXT NOT NULL UNIQUE,
            archetype  TEXT NOT NULL,
            incident   TEXT NOT NULL,
            culprit    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS round2_case_files (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id       TEXT NOT NULL,
            file_id       TEXT NOT NULL,
            timeline_tag  TEXT NOT NULL,
            filename      TEXT NOT NULL,
            content_text  TEXT NOT NULL,
            is_locked     INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (case_id) REFERENCES round2_cases(case_id) ON DELETE CASCADE,
            UNIQUE (case_id, file_id)
        );

        CREATE TABLE IF NOT EXISTS round2_case_suspects (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            case_id       TEXT NOT NULL,
            suspect_name  TEXT NOT NULL,
            user_id       TEXT NOT NULL,
            role          TEXT NOT NULL,
            FOREIGN KEY (case_id) REFERENCES round2_cases(case_id) ON DELETE CASCADE,
            UNIQUE (case_id, suspect_name),
            UNIQUE (case_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS round2_team_cases (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id      INTEGER NOT NULL UNIQUE,
            case_id      TEXT NOT NULL,
            assigned_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (case_id) REFERENCES round2_cases(case_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS round2_case_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id      INTEGER NOT NULL,
            case_id      TEXT NOT NULL,
            assigned_at  TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (team_id, case_id)
        );
        """
    )


def _case_folders():
    if not CASES_DIR.is_dir():
        raise RuntimeError(f"Round 2 case folder not found: {CASES_DIR}")
    folders = sorted(p for p in CASES_DIR.iterdir() if p.is_dir() and p.name.startswith("R2-"))
    if not folders:
        raise RuntimeError(f"No R2-* case folders in {CASES_DIR}")
    return folders


def _problems(case, folder) -> list:
    """Everything wrong with a case folder (an empty list means it is safe to load)."""
    problems = []
    for key in ("case_id", "archetype", "incident", "culprit", "candidates", "player_files"):
        if not case.get(key):
            problems.append(f"missing '{key}'")
    if problems:
        return problems

    if case["case_id"] != folder.name:
        problems.append(f"case_id {case['case_id']} does not match folder {folder.name}")

    files = case["player_files"]
    if set(files) != set(_TIMELINE_TAGS):
        problems.append(f"player_files must be exactly alpha, beta, gamma (got {sorted(files)})")
    for file_id, filename in files.items():
        if not (folder / filename).is_file():
            problems.append(f"file {filename} ({file_id}) not found")

    candidates = case["candidates"]
    if len(candidates) < 2:
        problems.append("needs at least 2 candidates")
    for candidate in candidates:
        if not all(candidate.get(k) for k in ("name", "user_id", "role")):
            problems.append(f"candidate needs name, user_id and role: {candidate}")
    names = [str(c.get("name", "")).strip().lower() for c in candidates]
    ids = [str(c.get("user_id", "")).strip().lower() for c in candidates]
    if len(set(names)) != len(names) or len(set(ids)) != len(ids):
        problems.append("duplicate candidate name or user_id")
    if case["culprit"].strip().lower() not in names:
        problems.append(f"culprit '{case['culprit']}' is not one of the candidates")
    return problems


def seed_cases(connection) -> int:
    """Load the case folders into the database (safe to run any number of times)."""
    folders = _case_folders()

    # Load once per server start (this is called on every request). Because the
    # upserts below overwrite, editing a case file and restarting the server is
    # enough to update it.
    key = str(connection.execute("PRAGMA database_list").fetchone()[2])
    if key in _seeded:
        return len(folders)
    _seeded.add(key)

    loaded = 0
    for folder in folders:
        # A broken case folder must never stop the game: it is skipped (and reported),
        # and the other cases keep working. A previously loaded copy stays as it was.
        try:
            case = json.loads((folder / "case.json").read_text(encoding="utf-8"))
            problems = _problems(case, folder)
        except Exception as error:
            case, problems = None, [f"cannot read case.json: {error}"]
        if problems:
            print(f"[round2] SKIPPED {folder.name}: " + "; ".join(problems))
            continue
        case_id = case["case_id"]

        connection.execute(
            "INSERT INTO round2_cases (case_id, case_code, archetype, incident, culprit) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(case_id) DO UPDATE SET archetype = excluded.archetype, "
            "incident = excluded.incident, culprit = excluded.culprit",
            (case_id, case_id, case["archetype"], case["incident"], case["culprit"]),
        )

        for file_id, filename in case["player_files"].items():
            connection.execute(
                "INSERT INTO round2_case_files (case_id, file_id, timeline_tag, filename, content_text) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(case_id, file_id) DO UPDATE SET timeline_tag = excluded.timeline_tag, "
                "filename = excluded.filename, content_text = excluded.content_text",
                (case_id, file_id, _TIMELINE_TAGS[file_id], filename,
                 (folder / filename).read_text(encoding="utf-8")),
            )

        for candidate in case["candidates"]:
            connection.execute(
                "INSERT INTO round2_case_suspects (case_id, suspect_name, user_id, role) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(case_id, suspect_name) DO UPDATE SET user_id = excluded.user_id, "
                "role = excluded.role",
                (case_id, candidate["name"], candidate["user_id"], candidate["role"]),
            )

        # Drop anything the case no longer has (a removed suspect, a renamed file).
        marks = ",".join("?" * len(case["candidates"]))
        connection.execute(
            f"DELETE FROM round2_case_suspects WHERE case_id = ? AND suspect_name NOT IN ({marks})",
            (case_id, *[c["name"] for c in case["candidates"]]),
        )
        marks = ",".join("?" * len(case["player_files"]))
        connection.execute(
            f"DELETE FROM round2_case_files WHERE case_id = ? AND file_id NOT IN ({marks})",
            (case_id, *case["player_files"].keys()),
        )
        loaded += 1

    return loaded


def get_case(connection, team_id):
    """The case this team is playing, or None if none has been assigned yet."""
    return connection.execute(
        "SELECT c.* FROM round2_team_cases tc JOIN round2_cases c ON c.case_id = tc.case_id "
        "WHERE tc.team_id = ?",
        (int(team_id),),
    ).fetchone()


def assign_case(connection, team_id):
    """Give the team a random case out of the 24 that it has not played before."""
    team_id = int(team_id)
    current = get_case(connection, team_id)
    if current is not None:
        return current

    played = {r[0] for r in connection.execute(
        "SELECT case_id FROM round2_case_history WHERE team_id = ?", (team_id,))}
    all_cases = [r[0] for r in connection.execute("SELECT case_id FROM round2_cases ORDER BY case_id")]

    pool = [cid for cid in all_cases if cid not in played]
    if not pool:                      # this team has played all 24: start the cycle again
        pool = all_cases
        connection.execute("DELETE FROM round2_case_history WHERE team_id = ?", (team_id,))
    case_id = random.SystemRandom().choice(pool)

    connection.execute("INSERT OR IGNORE INTO round2_team_cases (team_id, case_id) VALUES (?, ?)",
                       (team_id, case_id))
    connection.execute("INSERT OR IGNORE INTO round2_case_history (team_id, case_id) VALUES (?, ?)",
                       (team_id, case_id))
    return get_case(connection, team_id)


def case_files(connection, case_id):
    return connection.execute(
        "SELECT file_id, timeline_tag, filename, content_text, is_locked "
        "FROM round2_case_files WHERE case_id = ? ORDER BY file_id",
        (case_id,),
    ).fetchall()


def case_suspects(connection, case_id):
    return connection.execute(
        "SELECT suspect_name, user_id, role FROM round2_case_suspects WHERE case_id = ? ORDER BY id",
        (case_id,),
    ).fetchall()


def project_name(file_id: str) -> str:
    return _PROJECT_NAMES.get(file_id, file_id.title())
