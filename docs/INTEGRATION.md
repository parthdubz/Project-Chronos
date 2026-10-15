# Project Chronos: integrated build (Rounds 1-3 + admin console)

One application, one database, one login. A team plays:

```
Login -> Round 1 -> Round 2 (investigation) -> Lobby -> START ROUND 3 -> Round 3 -> Completion
```

The host uses `/admin` or `/leaderboard` (server-side password): one screen with the podium, standings table and teams section.

## Run it

```bash
pip install -r backend/requirements.txt          # fastapi, uvicorn
cd frontend && npm ci && npm run build && cd ..  # creates frontend/dist
cp .env.example .env                             # then fill in the values (never commit .env)
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```

Players open `http://<server-ip>:8000/`, the host opens `http://<server-ip>:8000/admin`.
For development: `npm run dev` in `frontend/` (set `VITE_API_BASE` if the API is not on :8000).

## Environment variables (environment or `.env`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `CHRONOS_ADMIN_PASSWORD` | for the admin console | Host password. Empty = admin API disabled (503). There is no default. |
| `CHRONOS_ADMIN_SECRET` | no | Signing secret for admin tokens (derived from the password when empty). |
| `GROQ_API_KEYS` / `GROQ_API_KEY` / `GROQ_MODEL` | no | Round 2 analyst, tried first. Comma separated list of Groq keys: each question starts on the next key; a rate-limited or rejected key is skipped for a while and the model cascade (gpt-oss-120b, gpt-oss-20b, qwen3.8-27b) is walked on that key. |
| `GEMINI_API_KEYS` / `GEMINI_API_KEY` / `GEMINI_MODEL` | no | Round 2 analyst, tried when every Groq key failed (or none is set). |
| `CHRONOS_AI_DISABLED` | no | `1` = never call a provider. With no working key the built-in case-safe replies are used, so Round 2 always works. |
| `AI_TOTAL_TIMEOUT` | no | Seconds one question may spend over all attempts (default 20). |
| `ROUND2_DURATION_SECONDS` | no | Round 2 length (default 1200). |
| `CORS_ORIGINS` | no | Only for a separately hosted frontend (default `*`). |
| `CHRONOS_DB_PATH` | no | Use another SQLite file (default `backend/chronos.db`). Used by the tests. |

## Tests

```bash
pip install -r backend/requirements-dev.txt       # adds httpx for the test client
python -m unittest backend.tests.test_integration -v
```

They run against a temporary database (never `backend/chronos.db`) and cover login/session tokens,
team isolation, Round 1, Round 2 completion and timeout, the Round 3 gate and evidence rules,
duplicate submission, admin protection, the read-only leaderboard, and repeatable migrations.

## How the pieces connect

- **Identity.** Login returns `session_token`; the browser keeps it with the session and sends it as
  `X-Team-Token` on every Round 1/2/3 call (the Round 2 page reads it from the same session). The
  server requires the token to match the `team_id` being acted on, so editing `team_id` in a request
  cannot open another team's data. An old browser session without a token is sent back to login.
- **Round 2** is investigation-only. `POST /api/round2/complete` (or the clock) ends it and puts the
  team in the Lobby; no score or culprit is needed. The legacy culprit-submission code is kept in
  `round2_service.submit_culprit` but is no longer routed.
- **Lobby -> Round 3.** The existing Round 2 Lobby (`frontend/public/round2/index.html`) has a
  `START ROUND 3` button. It calls `POST /api/round3/start`, which the server accepts only once
  Round 2 is over (completed, timed out, or the deadline has passed). Round 3 never starts by itself.
- **Round 3.** `GET /api/round3/scenario` is read-only; `POST /api/round3/submit` needs a candidate of
  the team's own case and at least two evidence items from that case. One decision per team; a repeat
  returns the stored result. The culprit, valid evidence and narrative never leave the database before
  the team's own decision; `/verdict` returns only what the team filed and the debrief narrative.
- **Round 2 evidence and Round 3 cases.** `python backend/tools/generate_cases.py` regenerates the 24 evidence
  sets (`backend/data/round2_cases_all_24/`) and the matching 24 Round 3 cases (`backend/app/data/round3_cases.json`)
  together, so the files a Round 3 evidence item cites are the files the team investigated. Each case has the
  four files `system_changes.log`, `login_records.log`, `security_keys.log`, `incident_report.txt` (plain
  language: badges, terminals written by name, one clock, VIEW ONLY < TEST ONLY < FULL CONTROL); the culprit is Project Alpha /
  Beta / Gamma (8 each); three files support the accusation and one does not, and which one differs per
  case. **No single file is enough**: only `login_records.log` says which project owns a badge (BADGE
  REGISTRY); the change, key and incident files carry badges only. A team's Round 3 case is the one
  that matches its own Round 2 case. `python -m unittest backend.tests.test_cases` checks every case is
  solvable with a single answer and that no single file names or determines the culprit.
- **Round 2 screen** is an editor-style layout: file explorer (left), tabbed read-only viewer with line
  numbers (centre), analyst chat (right), COMPLETE INVESTIGATION at the top.
- **Round 2 questions.** Each distinct question is charged once (5, 5, 10). A retry with the same
  `request_id`, or the same text asked again, returns the stored answer free; a charged-but-unanswered
  question is answered without a second charge. Files, progress, reloads and COMPLETE never deduct.
- **Leaderboard UI.** `/leaderboard` and `/admin` open the same single admin screen (there is no separate console):
  podium + standings table + a Teams section, in the design of `03-round3-source/frontend/public/leaderboard.html` (`frontend/src/admin/Leaderboard.jsx`,
  `frontend/src/styles/leaderboard.css`), behind the admin token. Extras: stage per team, Round 2 question
  count / LIVE marker, total time for finished teams, stage filter, sort, auto-sync pause, **Projector** mode
  (fullscreen, PRNs and controls hidden) and CSV export. It only reads.
- **Admin.** Every `/api/admin/*` route except `/login` needs the signed bearer token. The leaderboard
  only reads: it never writes scores. A round with no recorded result shows `-`, not 0.
  Ranking: total, then earlier Round 3 / Round 2 / Round 1 completion.

## Before the event

1. Set `CHRONOS_ADMIN_PASSWORD` (and optionally `GEMINI_API_KEY`) in `.env`.
2. Back up `backend/chronos.db`, then start the server once: the Round 2 case library is
   re-synchronised from `backend/data/round2_cases_all_24/` and the Round 3 tables are created/upgraded.
3. Teams that were logged in before this build must log in again (their old session has no token).
4. Decide the Round 2 scoring rule (see below) before the awards.

## Known limits

- Round 2 scoring is only the AI-question deduction (spec "CHATBOT LIMIT": start 20, questions cost
  5 / 5 / 10, three questions maximum). There is no culprit component, so the leaderboard Round 2 value
  is 20 minus the recorded deductions, shown as LIVE while Round 2 is running and `-` for a team that
  has not started it. Totals are labelled PARTIAL until all three rounds are recorded. Whether the Round 2
  maximum should stay 20 now that the culprit component is gone has not been confirmed.
- The admin "clear database" action from the Round 3 source was not ported (too destructive for a
  live event); reset the database from the command line instead.
- Admin login throttling is in-memory (per process).

## Round 2 analyst AI: providers and fall-over

`backend/app/services/ai_service.py`, tried in this order for each question:

1. **Groq**: every configured key, each with a model cascade. Keys rotate round-robin so teams
   spread over the pool; HTTP 429 rests a key for the `Retry-After` time (default 60 s), 401/403
   (and Google's `API key not valid`) for 10 minutes; a retired model is skipped for 10 minutes.
2. **Gemini**: the same, with its own keys and models.
3. **Built-in replies** (`round2_service._fallback_reply`): used when nothing answered, and
   whenever a model reply would name the culprit (`_leaks_culprit`).

The host can see the state at `GET /api/admin/ai-status` (admin token): provider names, number
of keys, how many are resting, models, last error. It never returns a key. Keys live only in the
git-ignored `.env`; nothing secret is written in the code, the logs or the status.
