# Round 2 AI Suggestion Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show 3 clickable AI-question suggestion chips above the chat input in the Round 2 "CHRONOS Analyst" panel, varying per case, visible only before the team has asked their first AI question.

**Architecture:** The backend picks 3 strings deterministically from a fixed, case-safe template pool using the team's `case_id` as the random seed (so the same case always gets the same 3 suggestions, and different cases get different sets), and returns them as a new `chat_suggestions` array in the existing `/api/round2/progress` payload. The frontend (a single static HTML/JS/CSS file, no build step) renders them as chips in a new `#sugg` container, shown only while `ai.used === 0` (the existing field that already tracks questions asked) — no new persistence needed, since once a team asks one question `used` never goes back to 0 for that case, so the chips disappear permanently and correctly reflect "first use only" even across reloads. Clicking a chip fills the existing `#qi` input (not auto-send), matching how the input already works.

**Tech Stack:** Python (FastAPI backend, stdlib `random` only, no new dependency), vanilla JS/CSS (the existing `frontend/public/round2/index.html`, no build step, no new dependency).

---

## Context for the implementer

- `backend/app/services/round2_service.py` is the Round 2 backend logic. `_progress(connection, team)` (around line 306) builds the JSON the frontend polls via `GET /api/round2/progress` (routed in `backend/app/routes/round2.py:25-27`) and also returns after `/start` and after each `/chat` call. It already has access to `team`, and calls `_case(connection, team)` (defined at line 211) elsewhere in this file to get the team's case row (`case_id` on it).
- The AI chat's own system prompt / deduction logic lives in `_system_prompt()` and `chat()` in the same file — **do not touch those**. This plan only adds a sibling field to the progress payload; it changes no scoring, timer, or chat logic.
- `MAX_AI_QUESTIONS = 3`, `AI_DEDUCTIONS = (5, 5, 10)`, `AI_BUDGET = sum(AI_DEDUCTIONS)` are defined at lines 35-37.
- The frontend file `frontend/public/round2/index.html` is a single self-contained page (no npm dependency, no build step — it is served as-is by the backend and copied into `frontend/dist/round2/index.html` only when `npm run build` runs in `frontend/`). After any edit to it, **you must rebuild** (`cd frontend && VITE_API_BASE=/ npm run build`) or the live app keeps serving the old copy — this has bitten previous work in this session twice already.
- `sync(p)` (line 199) is called every time the frontend receives a progress payload; it calls `meter()` and `aiUi()`. `aiUi()` (line 202) is where question-counter text and input enable/disable state are set from `S.prog.ai`. This is also where the new suggestion-chip rendering belongs, since it already has `a = S.prog.ai` in scope.
- The HTML for the chat panel is:
  ```html
  <aside id="ai"><div class="pt">Chronos analyst</div><div id="chat" aria-live="polite"></div><div id="qc"></div>
  <div class="in"><span>&gt;</span><input id="qi" placeholder="ask about the evidence" autocomplete="off" maxlength="300"></div></aside>
  ```
  (`frontend/public/round2/index.html:144-145`). The new chip container goes between `#qc` and `.in`.
- `el(t,c,h)` is the tiny DOM helper already defined at line 162: `const $=s=>document.querySelector(s),el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.textContent=h;return e};`
- `.in{display:flex;align-items:center;margin:4px 10px 10px;min-height:50px;border:1px solid var(--ink);background:rgba(34,211,238,.07)}` is at line 89 — new chip CSS goes near it.
- Backend tests: there is no separate unit-test file for `round2_service.py`; API-level behavior is tested in `backend/tests/test_integration.py`'s `IntegrationTests` class (run with `CHRONOS_AI_DISABLED=1` to skip live AI calls: `CHRONOS_AI_DISABLED=1 python -m unittest backend.tests.test_integration -v`). `test_04_round2_investigation_only_and_lobby` already starts Round 2 for a team and checks the files list — extend it there.
- Data-safety rule already established in this codebase (see `backend/tools/generate_cases.py` and `backend/tests/test_cases.py`'s `test_no_file_names_the_culprit_outright` / `PROJECT_NAME` regex checks): **nothing shown to a player may name a project (Alpha/Beta/Gamma) or the word "culprit"/"responsible project"/"guilty"**. The suggestion templates below are deliberately generic (no case facts at all), so this is satisfied by construction — but Task 1's test must still assert it, consistent with how every other player-facing text in this codebase is checked.

---

### Task 1: Backend — deterministic per-case suggestion picker, wired into `/progress`

**Files:**
- Modify: `backend/app/services/round2_service.py:23-27` (imports), `:35-37` (constants area), `:306-345` (`_progress`)
- Test: `backend/tests/test_integration.py` (extend `test_04_round2_investigation_only_and_lobby`)

- [ ] **Step 1: Add the `random` import**

In `backend/app/services/round2_service.py`, the import block currently reads (lines 23-27):

```python
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
```

Change it to:

```python
import json
import os
import random
import re
import sqlite3
from datetime import datetime, timedelta, timezone
```

- [ ] **Step 2: Add the suggestion pool and picker function**

Immediately after the existing constants block (after `AI_BUDGET = sum(AI_DEDUCTIONS)` at line 37), add:

```python

# Generic, case-safe starter questions for the AI analyst chat. None of these mention a
# project, a badge, or any case-specific fact - they are templates about *how to read the
# evidence*, not about what the evidence says - so they need no per-case leak checking beyond
# what test_no_file_names_the_culprit_outright already enforces on every player-facing string.
CHAT_SUGGESTION_POOL = (
    "Summarize what each of the four files tells us.",
    "Which file doesn't point at a responsible project on its own?",
    "Walk me through how the change, the key, and the badge connect.",
    "What's unusual about the incident timeline?",
    "Explain how the badge registry works.",
    "What's the difference between a key being ARMED and being USED?",
    "Which login in login_records.log looks suspicious, and why?",
    "What does FULL CONTROL mean compared to VIEW ONLY or TEST ONLY?",
    "Are there any gaps or missing records in the logs?",
    "What should I compare first to find the responsible project?",
)


def _chat_suggestions(case_id: str) -> list:
    """3 starter questions, deterministically picked from CHAT_SUGGESTION_POOL using the
    case id as the random seed: the same case always gets the same 3 (stable across
    reloads and across teams who get the same case), and different cases get different
    sets, without needing any per-case generation or storage."""
    return random.Random(case_id).sample(CHAT_SUGGESTION_POOL, 3)
```

- [ ] **Step 3: Return the suggestions from `_progress`**

In `_progress(connection, team)` (starts at line 306), the function currently does NOT have the case loaded (it only has `team`). Add the case lookup and the new field. The function currently reads:

```python
def _progress(connection, team) -> dict:
    tid = str(team["id"])
    rows = connection.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(points_deducted), 0) AS lost "
        "FROM round2_chat_messages WHERE team_id = ?",
        (tid,),
    ).fetchone()
    used, lost = rows["n"], rows["lost"]
    sub = connection.execute("SELECT * FROM round2_submissions WHERE team_id = ?", (tid,)).fetchone()
    started = team["round2_started_at"]

    return {
        "team_id": team["id"],
        "team_name": team["team_name"],
        "state": team["current_state"],
        "ai": {
            "max_questions": MAX_AI_QUESTIONS,
            "used": used,
            "remaining": MAX_AI_QUESTIONS - used,
            "points_remaining": AI_BUDGET - lost,
            "next_cost": AI_DEDUCTIONS[used] if used < MAX_AI_QUESTIONS else 0,
            "deductions": list(AI_DEDUCTIONS),
        },
```

Change the first line and the `"ai"` block to add `chat_suggestions` as a sibling of `"ai"` (not inside it, since it is independent of the AI quota/points):

```python
def _progress(connection, team) -> dict:
    tid = str(team["id"])
    rows = connection.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(points_deducted), 0) AS lost "
        "FROM round2_chat_messages WHERE team_id = ?",
        (tid,),
    ).fetchone()
    used, lost = rows["n"], rows["lost"]
    sub = connection.execute("SELECT * FROM round2_submissions WHERE team_id = ?", (tid,)).fetchone()
    started = team["round2_started_at"]
    case = _case(connection, team)

    return {
        "team_id": team["id"],
        "team_name": team["team_name"],
        "state": team["current_state"],
        "ai": {
            "max_questions": MAX_AI_QUESTIONS,
            "used": used,
            "remaining": MAX_AI_QUESTIONS - used,
            "points_remaining": AI_BUDGET - lost,
            "next_cost": AI_DEDUCTIONS[used] if used < MAX_AI_QUESTIONS else 0,
            "deductions": list(AI_DEDUCTIONS),
        },
        # Shown by the frontend only while ai.used == 0 ("first use"); not re-computed
        # per question, just always present here so the frontend never needs a second call.
        "chat_suggestions": _chat_suggestions(case["case_id"]),
```

Leave every line after that (`"submitted": sub is not None,` etc.) unchanged — only the two blocks above change, and only by addition.

- [ ] **Step 4: Verify `_case` is safe to call here**

`_case(connection, team)` (line 211) calls `round2_cases.assign_case(connection, team["id"])`, which is already called multiple times per request elsewhere in this same file (e.g. in `list_files`, `read_file`, `list_suspects`) and is idempotent (a team keeps the same case once assigned). No change needed — this step is just confirming it by reading `round2_cases.assign_case`'s docstring/body, not writing code.

- [ ] **Step 5: Extend the integration test**

In `backend/tests/test_integration.py`, find `test_04_round2_investigation_only_and_lobby` (it already does `start = p.post("/api/round2/start", ...)` and checks `files`). Right after the existing `files = p.get("/api/round2/files").json()` block and its assertions (do not remove anything), add:

```python
        prog = start.json()
        self.assertEqual(len(prog["chat_suggestions"]), 3)
        self.assertEqual(len(set(prog["chat_suggestions"])), 3)  # no duplicate picks
        for q in prog["chat_suggestions"]:
            self.assertNotRegex(q.lower(), r"project (alpha|beta|gamma)|culprit|responsible project|guilty")
        # same case -> same suggestions on a later poll (deterministic, not re-rolled)
        again = p.get("/api/round2/progress").json()
        self.assertEqual(again["chat_suggestions"], prog["chat_suggestions"])
```

- [ ] **Step 6: Run the test**

Run: `cd /d/01-main && CHRONOS_AI_DISABLED=1 python -m unittest backend.tests.test_integration.IntegrationTests.test_04_round2_investigation_only_and_lobby -v`
Expected: `OK` (1 test passed).

- [ ] **Step 7: Run the full backend suite to confirm nothing else broke**

Run: `cd /d/01-main && CHRONOS_AI_DISABLED=1 python -m unittest backend.tests.test_cases backend.tests.test_integration -v`
Expected: `OK` (all tests pass; 38 total — 37 existing + the new assertions folded into test_04, so the count of test *methods* stays the same, only assertions inside one method grew).

- [ ] **Step 8: Commit**

```bash
cd /d/01-main
git add backend/app/services/round2_service.py backend/tests/test_integration.py
git commit -m "feat(round2): add 3 deterministic per-case AI chat suggestions to /progress"
```

---

### Task 2: Frontend — render the suggestion chips, shown only before the first question

**Files:**
- Modify: `frontend/public/round2/index.html` (HTML at line ~144-145, CSS near line ~89, JS `aiUi()` at line ~202)

- [ ] **Step 1: Add the chip container to the HTML**

In `frontend/public/round2/index.html`, find (around line 144-145):

```html
<aside id="ai"><div class="pt">Chronos analyst</div><div id="chat" aria-live="polite"></div><div id="qc"></div>
<div class="in"><span>&gt;</span><input id="qi" placeholder="ask about the evidence" autocomplete="off" maxlength="300"></div></aside>
```

Change to (adds `<div id="sugg" hidden></div>` between `#qc` and the input row):

```html
<aside id="ai"><div class="pt">Chronos analyst</div><div id="chat" aria-live="polite"></div><div id="qc"></div>
<div id="sugg" hidden></div>
<div class="in"><span>&gt;</span><input id="qi" placeholder="ask about the evidence" autocomplete="off" maxlength="300"></div></aside>
```

(`[hidden]{display:none!important}` is already defined globally at line 10 of this file, so the `hidden` attribute is enough to start closed.)

- [ ] **Step 2: Add CSS for the chips**

Find (around line 89):

```css
.in{display:flex;align-items:center;margin:4px 10px 10px;min-height:50px;border:1px solid var(--ink);background:rgba(34,211,238,.07)}
```

Add immediately before it:

```css
#sugg{display:flex;flex-wrap:wrap;gap:6px;margin:0 10px 8px;padding:8px;border:1px dashed var(--line);background:rgba(34,211,238,.04)}
#sugg .sl{width:100%;font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.sugg-chip{border:1px solid var(--dim);color:var(--cyan);padding:4px 10px;font-size:17px;text-align:left;cursor:pointer;background:rgba(34,211,238,.05)}
.sugg-chip:hover{border-color:var(--ink);background:rgba(34,211,238,.15);color:#fff}
.in{display:flex;align-items:center;margin:4px 10px 10px;min-height:50px;border:1px solid var(--ink);background:rgba(34,211,238,.07)}
```

- [ ] **Step 3: Render the chips from `aiUi()`**

Find `aiUi()` (around line 202):

```javascript
function aiUi(){const a=S.prog.ai,i=$('#qi'),qc=$('#qc');
 if(S.prog.submitted||S.prog.completed){i.disabled=true;i.placeholder='Investigation filed';qc.textContent='ROUND 2 CLOSED';return}
 if(!live()){i.disabled=true;i.placeholder='Round 2 is closed';qc.textContent='ROUND 2 CLOSED';return}
 if(a.remaining<=0){i.disabled=true;i.placeholder='No AI questions remaining';qc.textContent='NO QUESTIONS LEFT · AI POINTS: '+a.points_remaining;return}
 i.disabled=false;i.placeholder='Ask the analyst...';
 qc.textContent=`QUESTION ${a.used}/${a.max_questions} · COSTS -${a.next_cost} PTS · ENTER`}
```

Replace with (adds a call to a new `renderSuggestions(a)` at the very start, and a case at every early `return` so the chips are hidden whenever the input itself is disabled for a reason unrelated to "first use"):

```javascript
function renderSuggestions(a){const s=$('#sugg');
 const show=a.used===0&&Array.isArray(S.prog.chat_suggestions)&&S.prog.chat_suggestions.length>0;
 s.hidden=!show;
 if(!show){s.innerHTML='';return}
 if(s.childElementCount)return; // already built for this poll; avoid re-render flicker
 s.innerHTML='';
 s.append(el('span','sl','Try asking'));
 S.prog.chat_suggestions.forEach(q=>{
  const b=el('button','sugg-chip',q);
  b.type='button';
  b.onclick=()=>{const i=$('#qi');i.value=q;i.focus()};
  s.append(b);
 });
}
function aiUi(){const a=S.prog.ai,i=$('#qi'),qc=$('#qc');
 renderSuggestions(a);
 if(S.prog.submitted||S.prog.completed){i.disabled=true;i.placeholder='Investigation filed';qc.textContent='ROUND 2 CLOSED';$('#sugg').hidden=true;return}
 if(!live()){i.disabled=true;i.placeholder='Round 2 is closed';qc.textContent='ROUND 2 CLOSED';$('#sugg').hidden=true;return}
 if(a.remaining<=0){i.disabled=true;i.placeholder='No AI questions remaining';qc.textContent='NO QUESTIONS LEFT · AI POINTS: '+a.points_remaining;return}
 i.disabled=false;i.placeholder='Ask the analyst...';
 qc.textContent=`QUESTION ${a.used}/${a.max_questions} · COSTS -${a.next_cost} PTS · ENTER`}
```

Note: `renderSuggestions` is called first and handles its own hide/show; the two early-return branches (`submitted`/`completed` and `!live()`) additionally force-hide `#sugg` because asking is impossible there even if `used` is still 0 (e.g. the round timed out before the team ever asked a question) — the `a.remaining<=0` branch does not need a forced hide since `used===0` and `remaining<=0` cannot both be true (`remaining = max_questions - used`, and `max_questions` is 3).

- [ ] **Step 4: Rebuild the frontend**

Run: `cd /d/01-main/frontend && VITE_API_BASE=/ npm run build`
Expected: build succeeds, no errors (ignore the pre-existing "chunk larger than 500kB" warning — unrelated).

- [ ] **Step 5: Verify the built copy picked up the change**

Run: `grep -c "renderSuggestions" /d/01-main/frontend/dist/round2/index.html`
Expected: `2` (the function definition plus its call site).

- [ ] **Step 6: Commit**

```bash
cd /d/01-main
git add frontend/public/round2/index.html frontend/dist/round2/index.html
git commit -m "feat(round2): show 3 AI suggestion chips above the chat input until first question"
```

---

### Task 3: Live verification

**Files:** none (manual check only, using the existing dev-skip flow already used earlier in this session)

- [ ] **Step 1: Start a throwaway backend**

Run (background):
```bash
cd /d/01-main/backend && CHRONOS_AI_DISABLED=1 CHRONOS_ENABLE_SKIP=1 CHRONOS_SECURE_MODE=0 python -m uvicorn app.main:app --host 127.0.0.1 --port 8130
```

- [ ] **Step 2: Create a team, skip to Round 2, open the Round 2 terminal in the browser pane**

Use the same login -> `/api/dev/skip-round` -> `/api/round2/start` -> set `localStorage.chronos_team_session`/`chronos_team_id` -> navigate to `http://127.0.0.1:8130/round2/index.html?boot=0&team_id=<id>` sequence already used earlier in this session for `README.md`/`FLOWCHART`/table verification.

- [ ] **Step 3: Confirm the chips appear before asking anything**

Screenshot the right-hand "CHRONOS ANALYST" panel. Expected: a dashed box reading "TRY ASKING" with 3 clickable chips above the input, before any question has been asked. Click one chip; expected: the input fills with that chip's text (not sent).

- [ ] **Step 4: Ask one real question, confirm the chips disappear and stay gone on reload**

Type a question and press Enter. After the reply arrives, expected: the chips are gone. Reload the page (same `team_id`, `boot=0`); expected: the chips stay gone (because `ai.used` is now `1`, not `0`).

- [ ] **Step 5: Stop the throwaway backend**

Run: `pkill -f "uvicorn app.main:app --host 127.0.0.1 --port 8130"`

---

## Self-review

- **Spec coverage:** "3 AI suggestions above the chat-box, related to the case study, different in every case, appears only once (first use)" — Task 1 picks 3 per-case-seeded suggestions (different per case via the `case_id` seed), Task 2 renders them above the input (`.in`, the actual text-entry box) and hides them once `ai.used > 0`, which is exactly "first use only" with no extra persistence needed. Covered.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact command with expected output.
- **Type consistency:** `_chat_suggestions(case_id: str) -> list` returns `list[str]`; frontend treats `S.prog.chat_suggestions` as a plain string array via `Array.isArray(...)` and `.forEach`. `chat_suggestions` is the field name used consistently in Task 1 (backend) and Task 2 (frontend `S.prog.chat_suggestions`). `renderSuggestions(a)` is defined once and called once, from `aiUi()`, with the same name both places.
