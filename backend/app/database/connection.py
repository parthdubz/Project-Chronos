import os
import sqlite3
from pathlib import Path

# The event database. CHRONOS_DB_PATH points the app (and the test-suite) at a
# different file; unset, it is backend/chronos.db exactly as before.
_override = os.environ.get("CHRONOS_DB_PATH", "").strip()
DB_PATH = Path(_override) if _override else Path(__file__).resolve().parents[2] / "chronos.db"

def get_connection():
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    # WAL: readers never wait for a writer and a commit is one append, so many teams
    # answering at once do not queue behind each other (the setting is stored in the file).
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.DatabaseError:
        pass
    return connection
