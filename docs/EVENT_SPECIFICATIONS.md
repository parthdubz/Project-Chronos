# Project CHRONOS - AI Club 2026
---

Symbitech 2026 - Event from AI Club, SIT Pune.

---
Year 2140. CHRONOS is a super-advanced AI that keeps the world’s technology timeline in
order — it knows what belongs to the past, the present, and the future, and keeps them
Separate. Something has gone wrong. CHRONOS has glitched, and Past, Present, and Future technologies are now mixed together into one broken timeline. The players are recruited as Temporal Engineers — outside experts brought in to fix what CHRONOS can’t fix about itself. Their job: figure out what caused the glitch, before the timeline
collapses completely.

<table>
<tr>
<th>SN</th>
<th>Round/Role</th>
<th>Details</th>
<th>Assigned to</th>
</tr>

<tr>
<td>1</td>
<td>Round 1 - Timeline Fragmentation</td>
<td>Puzzle based activity to classify technical items into past, present and future tech.</td>
<td>Snigdha and Triguna</td>
</tr>

<tr>
<td>2</td>
<td>Round 2 - Chronos Terminal</td>
<td>Physical split followed by the technical execution to find clues and details</td>
<td>Hrucha and Bhaskar</td>
</tr>

<tr>
<td>3</td>
<td>Round 3 - Final Decision</td>
<td>Gathering all the insights from Round 1 and 2 to make an informed decision</td>
<td>Samarth and Adwaiy</td>
</tr>

<tr>
<td>4</td>
<td>Authentication and Leaderboard</td>
<td>User authentication, logs and database connection and reflection.</td>
<td>Aashi and Parth</td>
</tr>

<tr>
<td>5</td>
<td>Documentation</td>
<td>Maintaining, managing and creating documentation.</td>
<td>Samarth</td>
</tr>

<tr>
<td>6</td>
<td>Inter Round Communication</td>
<td>Communicating between team members assigned for different rounds.</td>
<td>Iha</td>
</tr>

</table>

### ROUND 0: INTRODUCTION

* We will start with a short cinematic video introducing the story.
* The story is set in the year 2140, where CHRONOS is an advanced AI responsible for maintaining the Past, Present and Future technology timeline.
* Due to a glitch, the timelines have been mixed up.
* Participants become **Temporal Engineers**, whose task is to investigate the glitch and identify what caused it and who is responsible.

Before starting:

* Team name will be entered.
* Member 1 and Member 2 details will be entered.
* PRNs will be entered.
* A unique Team ID will be automatically generated.
* Once the team clicks START, the timer will begin.

---

### ROUND 1: TIMELINE FRAGMENT

The main purpose of Round 1 will be **observation, classification and speed**.

Instead of making it look like a normal static quiz, the entire UI should look like a *broken/glitched CHRONOS timeline*.

The screen should have:

* Scattered puzzle fragments.
* Broken pieces of the timeline.
* Shattered-screen/glitch effects.
* Flickering elements.
* Distorted timestamps.
* Past / Present / Future sections.
* Slightly moving or rotating fragments so that the UI does not feel static.
* A visible countdown timer.

The participants will have to reconstruct the broken timeline by joining/arranging the fragments correctly.

The fragments can contain:

* Technology images.
* Years.
* Timeline symbols.
* Small text clues.
* Visual information related to Past, Present and Future technologies.

Once the puzzle is correctly reconstructed, it should reveal the next clue.

### ROUND 1 CLUE

The clue revealed after solving the puzzle will be:

**"The timeline was not broken at the point of failure. Find the system that changed first."**

This clue should not directly reveal the culprit.

Its purpose is to tell participants that they should not simply blame the obvious error and instead investigate which system changed first.

After solving the puzzle, each team will receive a **unique authentication code/password** which will be required for the next stage.

For example:

* Team 001 → CHRONOS-17
* Team 002 → CHRONOS-42
* Team 003 → CHRONOS-83

The codes will be stored in the backend/database.

### ROUND 1 EVALUATION

There will be 25 classifications/images.

* Correct answer = **+2 points**
* Wrong answer = **-1 point**
* Maximum classification score = **50 points**
* Maximum negative score = **-25 points**

The time taken will also be recorded.

The finish button will remain accessible throughout the round.

The score itself does not need to be directly shown to participants while they are playing.

*Time should primarily act as a tie-breaker rather than overpowering accuracy.*

The participants must complete the puzzle and obtain the correct authentication code before moving forward.

---

# ROUND 2: CHRONOS TERMINAL

Round 2 will have two parts:

### ROUND 2.1: PHYSICAL SPLIT

After Round 1, participants will receive a clue directing them toward the physical part of the investigation.

The clue can be:

*"Three systems hold three pieces of the truth. One speaks about the future. One records the present. One remembers the past."*

Participants will then move around the event area/lab and find hidden authentication tokens/keywords.

For example, different locations can contain:

* AGENTIC
* OMEGA
* ALPHA
* BETA
* etc.

Instead of having one universal password, we will use multiple authentication keys so that teams cannot simply share one password with each other.

Each team can have its own required combination of tokens.

For example:

* TOKEN A → ALPHA-7
* TOKEN B → OMEGA-3
* TOKEN C → BETA-9

Once they find the required tokens, they will use them on their desktop to authenticate themselves.

After authentication, Round 2.2 will be unlocked.

---

# ROUND 2.2: THE VIRTUAL INVESTIGATION

After authentication, the desktop will open a *CHRONOS Internal Investigation Terminal*.

The UI should look like a fictional internal system rather than a normal website.

The screen will contain:

*PROJECT ALPHA*
Controls the *Future Timeline*

*PROJECT BETA*
Controls the *Present Timeline*

*PROJECT GAMMA*
Controls the *Past Timeline*

There will also be a *CHRONOS ANALYST AI* section.

The three project files will contain different types of evidence.

---

### FILE 1: PROJECT ALPHA

This will contain a file such as:

*future_audit.log*

Example information:

* Future Timeline accessed.
* Configuration modified.
* Unauthorized parameter detected.
* Change approved by a system/user.
* Timeline instability increased.

The purpose of this file is to show *what changed and when it changed*.

---

### FILE 2: PROJECT BETA

This will contain something like:

*incident_report.txt*

It can include:

* Initial symptoms.
* Time when the incident was detected.
* Present-system behaviour.
* Possible sources.
* Candidate information.

The purpose of this file is to show *what happened during the incident*.

---

### FILE 3: PROJECT GAMMA

This will contain something like:

*access_history.log*

It can include:

* Previous users.
* Access times.
* Read/modify/export actions.
* Authorized and unauthorized access.
* User/system IDs.

The purpose of this file is to show *who interacted with the system before the failure*.

---

### IMPORTANT LOGIC OF THE THREE FILES

We should NOT put the complete answer inside one file.

The participants should have to combine all three pieces of evidence.

For example:

*Alpha tells them:*
The system configuration was modified at 21:11.

*Beta tells them:*
The instability started immediately after the modification.

*Gamma tells them:*
Only one particular candidate had modification access around that time.

So the participants have to connect:

*Event → Time → Access → Candidate*

This is what will lead them toward identifying the culprit.

---

# ROUND 2: AI CHATBOT

The chatbot will act as a *restricted CHRONOS Investigation Assistant*.

It should NOT directly tell the participants who the culprit is.

The chatbot will have access to the three files and will help participants analyse the information.

The chatbot can help in four main ways:

### 1. Summarising evidence

Example:

Participant:

*"Summarize the important events from Alpha."*

AI:

*"The Future Timeline was modified at 21:11. The modification occurred before the reported instability."*

### 2. Cross-referencing files

Example:

*"Compare the Alpha modification time with Gamma access records."*

The AI can identify relationships between timestamps and access records.

### 3. Explaining contradictions

Example:

*"Does Beta's incident report agree with Alpha's audit?"*

The AI can point out differences between the reported incident time and the system modification time.

### 4. Providing analytical hints

Example:

*"What should we investigate next?"*

The chatbot can respond with something like:

*"Compare the timestamp of the first anomaly with the last authorized modification."*

However, the chatbot should NOT directly say:

*"Candidate X is the culprit."*

The participants must make that decision themselves.

---

### CHATBOT LIMIT

Each team will get only *3 AI questions*.

The scoring will work as follows:

* Starting AI investigation points = *20*
* First question = *-5 points*
* Second question = *-5 points*
* Third/final question = *-10 points*

Therefore:

* 0 questions → 20 points
* 1 question → 15 points
* 2 questions → 10 points
* 3 questions → 0 points

The number of remaining questions/points should be visible on the interface.

Once the team has completed its investigation, there will be a:

*COMPLETE INVESTIGATION → ROUND 3*

button.

---

# ROUND 2 EVALUATION

### Culprit identification:

* Correct candidate = *+30 points*
* Wrong candidate = *0 points*

### AI investigation:

Maximum = *20 points*

Therefore, Round 2 can provide a maximum of:

*50 points*

The idea is that teams should use the AI carefully. They are allowed to use it, but excessive dependence reduces their score.

---

# ROUND 3: FINAL DECISION / WISDOM ROUND

Round 3 should NOT have one universal final answer.

This is important because if Team 1 finishes first, they should not be able to walk outside and simply tell everyone:

*"The answer is X."*

Therefore, every team will receive a *unique final scenario/case*

The underlying logic will remain the same, but the following can change for each team:

* Candidate names.
* Candidate mapping.
* Timestamps.
* File IDs.
* Access IDs.
* Evidence combinations.
* Culprit.

For example:

*Team 001*

* Candidate A → Omega
* Candidate B → Sigma
* Candidate C → Delta
* Correct answer → Sigma

*Team 002*

* Candidate A → Sigma
* Candidate B → Delta
* Candidate C → Omega
* Correct answer → Delta

*Team 003*

* Candidate A → Delta
* Candidate B → Omega
* Candidate C → Sigma
* Correct answer → Omega

So even if one team reveals their answer outside, it will not directly help another team.

---

# ROUND 3 UI

The final interface should look like an emergency CHRONOS decision terminal.

It can contain:

*CHRONOS // FINAL DECISION*

*TEMPORAL COLLAPSE: IMMINENT*

Then:

* Candidate A
* Candidate B
* Candidate C

The participants will have to select:

*Who caused the timeline failure?*

They will also be shown the relevant evidence categories:

* Timeline modification
* Access history
* Incident timestamp
* System authorization

They must select the culprit and provide the evidence supporting their decision.

---

# ROUND 3 FINAL DECISION

Participants will have to:

1. Select the suspected culprit.
2. Select at least two pieces of supporting evidence.
3. Submit their final decision.

This prevents the final round from becoming a simple guess.

The backend will compare their answer against the unique case assigned to that team.

### Round 3 scoring:

* Correct culprit = *+30 points*
* Wrong culprit = *0 points*

The selected evidence can also be validated against the case to ensure that the team has actually followed the investigation logic.

---

# FINAL SCORING

The total score across all rounds will determine the winner.

### ROUND 1

Maximum:

*50 points*

### ROUND 2

Culprit identification:

*30 points*

AI investigation:

*20 points*

Maximum Round 2:

*50 points*

### ROUND 3

Final decision:

*30 points*

Therefore:

## TOTAL MAXIMUM SCORE = 130 POINTS

---

# TIE-BREAKER

If two teams have the same total score:

1. Round 3 completion time will be considered first.
2. If still tied, Round 2 completion time will be considered.
3. If still tied, Round 1 completion time will be considered.

The leaderboard will display the live scores.

---

# COMPLETE EVENT FLOW

*ROUND 0 → INTRODUCTION*

Story + Registration
↓
Team ID generated
↓
START
↓

*ROUND 1 → TIMELINE FRAGMENT*

Reconstruct broken timeline
↓
Classify / solve fragments
↓
Receive clue
↓
Receive unique authentication code
↓

*ROUND 2.1 → PHYSICAL SPLIT*

Find hidden tokens around the venue
↓
Complete physical mini-game
↓
Authenticate desktop
↓

*ROUND 2.2 → CHRONOS TERMINAL*

Open Alpha
↓
Open Beta
↓
Open Gamma
↓
Analyse logs and evidence
↓
Use CHRONOS AI Analyst
↓
Maximum 3 questions
↓
Identify probable culprit
↓

*ROUND 3 → FINAL DECISION*

Unique case assigned to each team
↓
Different candidate mapping/evidence
↓
Select culprit
↓
Select supporting evidence
↓
Submit final decision
↓

*FINAL*

Total Score
↓
Tie-breaker using completion time
↓
Live Leaderboard
↓
*WINNER*

So the overall progression will be:

*ROUND 1: SEE → ROUND 2: INVESTIGATE → ROUND 3: DECIDE*

This will be the final structure we follow for the technical implementation, UI design, clues, scoring and event flow. If there is anything else that needs to be added or modified, please let me know.

---