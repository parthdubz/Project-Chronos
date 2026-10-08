"""
Load the 24 Round 2 cases into the database and show who has which case.

    cd backend
    python -m app.seed_round2_cases

The server does exactly this on every start-up (see main.py -> init_round2), so this
script is only a manual check. It uses the same loader and the same random assignment
as the app, so the two can never disagree. The case folders are read from
`round2_cases_all_24/` in the project root; a broken case folder is skipped and
reported instead of stopping the load.
"""

from .database.connection import DB_PATH, get_connection
from .services import round2_cases
from .services.round2_service import init_round2


def main() -> None:
    print(f"database: {DB_PATH}")
    print(f"cases folder: {round2_cases.CASES_DIR}")

    init_round2()  # tables + cases + a case for every team that has none

    connection = get_connection()
    try:
        counts = connection.execute(
            "SELECT (SELECT COUNT(*) FROM round2_cases), (SELECT COUNT(*) FROM round2_case_files), "
            "(SELECT COUNT(*) FROM round2_case_suspects)"
        ).fetchone()
        print(f"cases: {counts[0]}   files: {counts[1]}   suspects: {counts[2]}")

        per_case = connection.execute(
            "SELECT case_id, COUNT(*) FROM round2_case_suspects GROUP BY case_id ORDER BY case_id"
        ).fetchall()
        sizes = sorted({row[1] for row in per_case})
        print(f"suspects per case: {', '.join(str(n) for n in sizes) or '-'}")

        teams = connection.execute(
            "SELECT t.id, t.team_name, tc.case_id FROM teams t "
            "LEFT JOIN round2_team_cases tc ON tc.team_id = t.id ORDER BY t.id"
        ).fetchall()
        if not teams:
            print("no teams yet: a team gets its case the moment it registers")
        for team in teams:
            print(f"  team {team['id']} ({team['team_name']}) -> {team['case_id']}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
