"""
Start ONE team's Round 2 over (uses the project's single database).

    cd backend
    python reset_round2_team.py 1          reset team 1
    python reset_round2_team.py 1 2 3      reset teams 1, 2 and 3

Removes the team's Round 2 AI questions, submission, Round 2 log events and
start/finish times, and sets it back to ROUND1_COMPLETED with Round 2 score 0.
The team keeps its case. Round 1 data and every other team are left alone.
"""

import sys

from app.database.connection import DB_PATH, get_connection


def reset(connection, team_id: int) -> None:
    team = connection.execute("SELECT team_name FROM teams WHERE id = ?", (team_id,)).fetchone()
    if team is None:
        print(f"team {team_id}: not found")
        return

    for table in ("round2_chat_messages", "round2_submissions"):
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (table,)).fetchone():
            connection.execute(f"DELETE FROM {table} WHERE team_id = ?", (str(team_id),))

    connection.execute(
        "DELETE FROM game_logs WHERE team_id = ? AND event_data LIKE '%\"round\": 2%'", (team_id,)
    )
    connection.execute(
        "UPDATE teams SET current_state = 'ROUND1_COMPLETED', round2_score = 0, "
        "total_score = COALESCE(round1_score, 0) + COALESCE(round3_score, 0), "
        "round2_started_at = NULL, round2_completed_at = NULL, updated_at = datetime('now') "
        "WHERE id = ?",
        (team_id,),
    )
    print(f"team {team_id} ({team['team_name']}): Round 2 reset")


if __name__ == "__main__":
    ids = sys.argv[1:]
    if not ids:
        sys.exit("usage: python reset_round2_team.py <team_id> [<team_id> ...]")
    connection = get_connection()
    try:
        print(f"database: {DB_PATH}")
        for team_id in ids:
            reset(connection, int(team_id))
        connection.commit()
    finally:
        connection.close()
