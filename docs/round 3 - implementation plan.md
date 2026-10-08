# PROJECT CHRONOS — ROUND 3: IMPLEMENTATION PLAN
**Round 3: Final Decision / Wisdom Round**  
*Document Version: 1.0.0*  
*Assigned Leads: Samarth & Adwaiy*  
*Target Stack: FastAPI (Python 3.11+) + React (Vite / Tailwind CSS) + SQLite*

---

# Part 1: Executive Summary (High-Level Overview)

### 1.1 Objective & Narrative Role
Round 3 is the climactic **"Wisdom Round"** of Project Chronos. As Temporal Engineers reaching the core CHRONOS mainframe under imminent timeline collapse (`TEMPORAL COLLAPSE: IMMINENT`), teams must synthesize all prior investigative findings (from Round 1 timeline classifications and Round 2 audit logs/incident reports/access history) to make the ultimate decision: **Identify the true culprit responsible for the timeline failure and cite at least two pieces of verified supporting evidence.**

### 1.2 Anti-Collusion Dynamic Case Architecture
To prevent teams who finish early from leaking answers (`"The culprit is X"`), Round 3 implements **Procedurally Generated / Deterministically Seeded Unique Team Scenarios**:
* **Permuted Candidate Mapping**: Names, roles, and candidate identifiers (Candidate A, B, C mapped dynamically across Omega, Sigma, Delta, etc.).
* **Dynamic Clue Graph**: Evidence combinations, timestamps, log IDs, and authorized access keys vary per team based on a deterministic seed derived from `team_id`.
* **Dynamic Correct Answer**: The true culprit and the valid set of supporting evidence match that team's specific scenario.

### 1.3 Key Rules & Scoring
* **Scoring**:
  * Correct Culprit Identified: **+30 Points**
  * Wrong Culprit Identified: **0 Points**
  * Maximum Round 3 Score: **30 Points** (Contributing to the overall event maximum of **130 Points**).
* **Evidence Validation**: Teams must select at least **two pieces of supporting evidence** (Timeline Modification, Access History, Incident Timestamp, System Authorization) corroborating their decision.
* **Tie-Breaker Rule**: Round 3 completion time is the **1st priority tie-breaker** for the overall event leaderboard, making speed and accuracy in this round decisive.

### 1.4 Architecture & Game Flow
```text
ROUND 2 COMPLETED
       │
       ▼ (State Transition: ROUND_3_ACTIVE)
┌─────────────────────────────────────────────────────────┐
│              CHRONOS // FINAL DECISION                   │
│         [ EMERGENCY TERMINAL UI / COUNTDOWN ]           │
├────────────────────────────┬────────────────────────────┤
│   Candidate Dossiers       │  Supporting Evidence Grid  │
│   - Candidate A (Sigma)    │  [ ] Timeline Modification │
│   - Candidate B (Delta)    │  [ ] Access History        │
│   - Candidate C (Omega)    │  [ ] Incident Timestamp    │
│                            │  [ ] System Authorization  │
└────────────────────────────┴────────────────────────────┘
       │
       ▼ Submit Final Decision (POST /api/round3/submit)
┌─────────────────────────────────────────────────────────┐
│ Server Validation & Scoring:                            │
│ - Verify Active State & Timer Expiry Guard             │
│ - Validate Selected Culprit Against Team Case Seed      │
│ - Validate Minimum 2 Supporting Evidence Selections     │
│ - Record Score (+30 / 0) and round3_completed_at        │
└─────────────────────────────────────────────────────────┘
       │
       ▼ (State Transition: DECISION_SUBMITTED -> FINAL_REVEAL)
COMPLETION PAGE (Team Stats, Final Score, Time, Verdict)
```

---

# Part 2: Detailed Technical Implementation Plan

## 2.1 Module 1: Case Generator & Scenario Mapping Engine

### 2.1.1 Location & Responsibility
* **File**: `backend/app/services/round3_service.py` & `backend/app/data/round3_cases.py` (or procedural generator).
* **Responsibility**: Deterministically generate or retrieve a unique, coherent investigative scenario for each team upon entering Round 3.

### 2.1.2 Scenario Data Model
Each scenario contains:
1. `case_id`: Unique string / integer identifier.
2. `candidates`: Array of 3 candidates (e.g., `id: "cand_a"`, `name: "Dr. Elena Vance (Omega Protocol Lead)"`, `alias: "Candidate A"`, `bio: "..."`).
3. `evidence_pool`: 4-6 evidence items categorised into:
   - `TIMELINE_MODIFICATION` (e.g., "Configuration parameter override executed at 21:11:04").
   - `ACCESS_HISTORY` (e.g., "Elevated root token utilized from Terminal Node Gamma-7").
   - `INCIDENT_TIMESTAMP` (e.g., "Temporal drift initiated 14 seconds post-override").
   - `SYSTEM_AUTHORIZATION` (e.g., "Override signed with biometric hash Sigma-9").
4. `culprit_candidate_id`: The ID of the guilty candidate for this team's case.
5. `valid_evidence_ids`: Set of evidence IDs that logically substantiate the guilt of the culprit.
6. `narrative_summary`: Factual post-investigation summary shown in the final reveal.

### 2.1.3 Deterministic Seeding Formula
To guarantee idempotency (same team always gets the same case on reload/reconnect):
```python
def get_or_generate_team_case(team_id: int) -> dict:
    # Use team_id as RNG seed or select from a pre-authored curated pool modulo N
    # Pre-authored curated cases guarantee 100% logical soundness and zero plot contradictions
```

---

## 2.2 Module 2: Database Schema & State Transitions

### 2.2.1 Tables & Schema Updates
In `backend/app/database/schema.py`:
1. **`teams` table** (already defined):
   - `round3_score` (INTEGER DEFAULT 0)
   - `round3_started_at` (TEXT ISO8601)
   - `round3_completed_at` (TEXT ISO8601)
   - `current_state` (TEXT)
2. **`round3_cases` (or stored in `submissions` / `game_logs`)**:
   ```sql
   CREATE TABLE IF NOT EXISTS round3_team_cases (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       team_id INTEGER UNIQUE NOT NULL,
       case_id TEXT NOT NULL,
       case_data TEXT NOT NULL, -- JSON string of the assigned scenario (stripped of secret answers)
       culprit_candidate_id TEXT NOT NULL,
       valid_evidence_ids TEXT NOT NULL, -- JSON array of correct evidence IDs
       created_at TEXT NOT NULL,
       FOREIGN KEY (team_id) REFERENCES teams(id)
   );
   ```
3. **`submissions` table** (record final choice):
   - `team_id`: Reference to team.
   - `round`: `3`
   - `reference_id`: Selected candidate ID.
   - `answer`: JSON payload with `{ "candidate_id": "...", "evidence_ids": ["...", "..."] }`
   - `is_correct`: `1` or `0`
   - `points_awarded`: `30` or `0`
   - `submitted_at`: Server timestamp.

### 2.2.2 State Machine Transitions
* Allowed transitions:
  * `ROUND_2_COMPLETED` ➔ `ROUND_3_ACTIVE` (Triggered when entering Round 3; sets `round3_started_at`)
  * `ROUND_3_ACTIVE` ➔ `DECISION_SUBMITTED` (Triggered on valid submission)
  * `DECISION_SUBMITTED` ➔ `FINAL_REVEAL` / `COMPLETED` (Calculates final score and unlocks completion view)
* Disallowed transitions:
  * Direct leap from `ROUND_1_ACTIVE` or `REGISTERED` to `ROUND_3_ACTIVE`.
  * Multiple submissions when already `DECISION_SUBMITTED` or `COMPLETED`.

---

## 2.3 Module 3: Backend API Endpoints & Business Logic

### 2.3.1 Routes Definition (`backend/app/routes/round3.py`)

#### 1. `POST /api/round3/start`
* **Input**: `{ "team_id": int }` (or extracted from session/token)
* **Pre-conditions**: Team state must be `ROUND_2_COMPLETED` or `ROUND_3_ACTIVE`.
* **Logic**:
  - If state is `ROUND_2_COMPLETED`, transition to `ROUND_3_ACTIVE` and set `round3_started_at = datetime.utcnow().isoformat()`.
  - Fetch or generate the team's assigned case.
  - Return case details **with solution fields filtered out**.
* **Response**:
  ```json
  {
    "status": "success",
    "team_state": "ROUND_3_ACTIVE",
    "round3_started_at": "2026-09-30T10:45:00Z",
    "case": {
      "case_id": "CASE-OMEGA-04",
      "emergency_header": "TEMPORAL COLLAPSE: IMMINENT",
      "candidates": [
        { "id": "cand_a", "name": "Dr. Aris Thorne", "designation": "Chronos Core Architecture Lead", "dossier": "..." },
        { "id": "cand_b", "name": "Commander V. Reyes", "designation": "Temporal Security Officer", "dossier": "..." },
        { "id": "cand_c", "name": "Chief Eng. Sarah Chen", "designation": "Timeline Sync Specialist", "dossier": "..." }
      ],
      "evidence_categories": [
        { "id": "ev_timeline", "category": "Timeline Modification", "description": "Audit delta shows unauthorized config rewrite at 21:11." },
        { "id": "ev_access", "category": "Access History", "description": "Sub-level 4 security clearance keycard logged during sector lock." },
        { "id": "ev_incident", "category": "Incident Timestamp", "description": "Chronos anomaly telemetry aligns with manual cycle bypass." },
        { "id": "ev_auth", "category": "System Authorization", "description": "Algorithmic safety governor disabled via override key SIGMA-9." }
      ]
    }
  }
  ```

#### 2. `GET /api/round3/scenario`
* **Input**: `team_id`
* **Logic**: Returns current case data and active state for page refresh recovery.

#### 3. `POST /api/round3/submit`
* **Input**:
  ```json
  {
    "team_id": 1,
    "selected_candidate_id": "cand_a",
    "selected_evidence_ids": ["ev_timeline", "ev_auth"]
  }
  ```
* **Validation & Scoring Logic**:
  1. Verify team exists and is in `ROUND_3_ACTIVE`.
  2. Verify `len(selected_evidence_ids) >= 2`.
  3. Load secret solution for team's assigned case:
     - Check if `selected_candidate_id == team_case.culprit_candidate_id`.
     - Check evidence validity (at least 2 matching valid evidence IDs).
  4. Scoring:
     - `is_correct = (selected_candidate_id == culprit_candidate_id)`
     - `points = 30 if is_correct else 0`
  5. Update `teams`:
     - `round3_score = points`
     - `total_score = round1_score + round2_score + points`
     - `round3_completed_at = datetime.utcnow().isoformat()`
     - `current_state = "COMPLETED"` (or `DECISION_SUBMITTED`)
  6. Insert record into `submissions` and log event into `game_logs`.
* **Response**:
  ```json
  {
    "status": "success",
    "verdict_recorded": true,
    "points_awarded": 30,
    "round3_score": 30,
    "total_score": 110,
    "completed_at": "2026-09-30T10:52:14Z",
    "next_state": "COMPLETED"
  }
  ```

---

## 2.4 Module 4: Frontend UI / UX Architecture

### 2.4.1 Location & Style Specifications
* **File**: `frontend/src/pages/Round3.jsx`
* **Style Theme**: Futuristic Emergency AI Terminal / Glitched Cyberpunk HUD.
* **Palette**: Dark slate/black backgrounds (`#0B0F19`), stark hazard amber/red accents (`#EF4444`, `#F59E0B`), electric cyan telemetry text (`#06B6D4`), crisp monospace typography for logs and IDs.

### 2.4.2 UI Components & Layout Hierarchy
1. **Emergency Header Banner**:
   - Flashing subtle warning indicator: `CHRONOS // EMERGENCY DECISION TERMINAL`
   - Subtitle: `TEMPORAL COLLAPSE: IMMINENT — PROTOCOL 2140`
   - Server synchronized countdown timer component (`<Timer />`) displaying remaining global round time.
2. **Main Decision Workspace (2-Column Split Layout)**:
   - **Left Column: Suspect Dossiers (Candidate Selection)**:
     - 3 interactive candidate cards.
     - Radio/card selector with holographic border highlight when active.
     - Collapsible/expanded dossier information (Role, Suspect Timeline, Motive/Discrepancy).
   - **Right Column: Supporting Evidence Grid**:
     - Checkbox grid grouped by category (Timeline Modification, Access History, Incident Timestamp, System Authorization).
     - Live validation counter badge: `Selected Evidence: X / Minimum 2 Required`.
     - Visual warning if fewer than 2 evidence pieces are selected.
3. **Submission & Confirmation Modal**:
   - Primary action button: `[ INITIATE FINAL PURGE & LOCK DECISION ]`.
   - Disabled until: (1) Exactly 1 candidate is selected AND (2) At least 2 evidence items are checked.
   - On click: Displays a high-tension confirmation dialog:
     > *"CAUTION: Once locked, temporal telemetry cannot be reverted. Confirm accusation of [Candidate Name] with [N] supporting logs?"*
4. **Post-Submission Cinematic Transition**:
   - Glitch screen wipe transition leading smoothly to `Completion.jsx`.

---

## 2.5 Module 5: Anti-Cheat, Reliability & Resilience

| Risk / Edge Case | Mitigation Strategy |
| :--- | :--- |
| **Answer Sharing across Teams** | Procedural/seeded case generator assigns unique culprit mappings and clue combinations per team. |
| **Brute-force / Rapid Submissions** | Backend idempotency lock: Only the first valid submission is processed; subsequent submissions return 409 Conflict. |
| **Network Disconnect / Refresh** | Game state and assigned case persist in SQLite. On mount, `Round3.jsx` fetches existing state and restores UI without losing progress. |
| **Client-Side Timer Tampering** | Server evaluates completion time against `round3_started_at` using server clock. Client timer is strictly visual. |
| **Arbitrary Skipping of Rounds** | Route guard on backend rejects `/api/round3/*` calls if team has not completed Round 2. |

---

## 2.6 Module 6: Step-by-Step Implementation Roadmap

### Phase 1: Case Data & Backend Core (Day 1)
- [x] Create `backend/app/data/round3_cases.py` with 5-10 balanced, logically verified scenario templates.
- [x] Implement `round3_service.py` to handle case assignment, evidence checking, and score computation.
- [x] Update `backend/app/database/schema.py` to include `round3_team_cases` table if storing extended case states.

### Phase 2: API Endpoints & State Machine (Day 1 - Day 2)
- [x] Implement `backend/app/routes/round3.py` (`/start`, `/scenario`, `/submit`).
- [x] Integrate state validation with `backend/app/services/game_service.py`.
- [x] Register `round3_router` inside `backend/app/main.py`.
- [x] Write backend unit tests in `backend/tests/test_round3.py` for scoring, evidence thresholds, and anti-cheat guards.

### Phase 3: Frontend Interface & Terminal Aesthetic (Day 2 - Day 3)
- [x] Build `Round3.jsx` using Tailwind CSS and terminal glitch aesthetic components.
- [x] Implement Candidate selection cards with active holographic glowing states.
- [x] Implement Evidence selection checkbox grid with live validation count.
- [x] Connect `api.js` endpoints (`startRound3`, `getRound3Scenario`, `submitRound3Decision`).
- [x] Add confirmation modal and navigation redirect to `Completion.jsx`.

### Phase 4: Integration, Admin Leaderboard & Verification (Day 3 - Day 4)
- [x] Test complete end-to-end player trajectory: Login ➔ Round 1 ➔ Round 2 ➔ Round 3 ➔ Completion.
- [x] Verify Admin Leaderboard reflects Round 3 score (+30 / 0) and accurately breaks ties using `round3_completed_at`.
- [x] Conduct multi-team concurrency test to verify scenario isolation.

---

# Part 3: Verification & Test Checklist

* [x] **Scenario Determinism**: Team 1 always receives Case 1 on reload; Team 2 receives Case 2.
* [x] **Evidence Constraint**: Submitting with 1 evidence item returns a 422/400 validation error.
* [x] **Scoring Accuracy**: Correct candidate awards exactly +30 points; incorrect awards 0 points.
* [x] **Tie-Breaker Integrity**: `round3_completed_at` is accurately recorded in UTC ISO8601 format.
* [x] **State Lockdown**: Once submitted, navigating back or calling `/submit` again cannot alter score or timestamp.

---

# Part 4: Unified Deployment & Launch Guide

### 🚀 One-Command Launch
```bash
./start.sh
# or
python3 run.py
```

### ⚙️ Database Hardening Configuration
- SQLite engine operates in **WAL Mode** (`PRAGMA journal_mode = WAL;`).
- Busy timeout set to **30,000ms** (`PRAGMA busy_timeout = 30000;`) to eliminate lock contention.
- Network exposure bound to `0.0.0.0` for full LAN player workstation connectivity.
- Dynamic DB path override supported via `CHRONOS_DB_PATH`.
