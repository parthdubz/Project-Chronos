# AI Club - Project Chronos Logs and Contributions
---

## Meeting 1: 30th September 2026, 6PM
Online Meeting Conducted by - Aditi.

### Demonstrations and Contributions as followed:
Meeting focussed majorly on the doubt solvings and made progress by finalising database stucture. Doubts regarding the events flow, execution and theme were addressed. Uniform tech stack was established.

- **Round 1:** Snigdha and Triguna working on ideation and waiting for images. Samarth will be generating images from FY Students for the Round 1 (waiting for feedback from events).
- **Round 2:** Hrucha and Bhaskar still in ideation state. Discussed Multifallback API Keys. Focussed on doubt resolutions.
- **Round 3:** Samarth and Adwaiy are waiting on the progress to make changes. UI Heavy round established. Showcased the implementation plan.
- **Authentication and Leaderboard:** Aashi and Parth demonstrated progress and showcased websites.
- **Database:** Aashi and Samarth finalised and presented detailed schema today. 
- **UI/UX:** Parth demonstrated work across rounds which will be incorporated.
- **FY Students:** Assigned Iha to keep constant correspondance and establish communication in case of first years unable to contribute due to Unit Tests.

Work execution needs to start and demonstration to be displayed by <b>3rd October 2026.</b>

---

## Friday, 2 October 2026

### Progress Logs
- **Round 1**: Image generation, prompting and saving finalised. First Years new recruits are incharge of that. Implementation files and logs updated.
- **Round 3**: Samarth and Adwaiy completed the full implementation of Round 3 (Wisdom Round / Final Decision):
  - **Dynamic Case Engine**: Implemented `round3_cases.py` with 8 balanced, logically verified scenario templates and anti-collusion deterministic seeding (`team_id` modulo & permutation generator).
  - **Database & Services**: Implemented unified SQLite schema updates with `round3_team_cases` and `round3_submissions`, atomic scoring (+30 / 0 points), server-authoritative timestamps, and idempotency protection.
  - **FastAPI Endpoints**: Implemented `/api/round3/start`, `/api/round3/scenario`, `/api/round3/submit`, `/api/round3/verdict`, and debug routes.
  - **Dramatic Visual UI/UX**: Created `Round3.jsx` following `theme.md` with Obsidian/Deep Violet/Electric Indigo/Solar Cream palette, holographic candidate dossier matrix, interactive tabbed profiles, supporting evidence correlation grid, Web Audio synthesizer cues, high-tension confirmation hold-to-lock modal, and cinematic debrief reveal leading to `Completion.jsx`.
  - **Testing & Verification**: Created and passed 10-point automated test suite in `backend/tests/test_round3.py`.
  - **Deployment & Connection Hardening**: Unified entire application deployment into single-command runners (`./start.sh` and `run.py`), hardened SQLite connection with WAL mode, 30s busy timeout, directory auto-provisioning, and 0.0.0.0 LAN binding across backend and frontend.

## Theme 
Finalised the theme by the Events Team and Samarth generated a .md file for documentation and easier access to the individual rounds by documenting it. Unified stack, database, theme established. Reference Palette also added therein.

#  
### Round 3 Implementation Complete - 2 October (Samarth and Adwaiy)

---

# Meeting 2 - 3rd October 2026

---

- 