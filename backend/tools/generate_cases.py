"""
Generate the 24 Round 2 evidence sets and the matching 24 Round 3 cases.

    python backend/tools/generate_cases.py

Writes (deterministically, so the output is reviewable and repeatable):

  backend/data/round2_cases_all_24/R2-01 ... R2-24/
      case.json                the case (culprit = Project Alpha / Beta / Gamma)
      system_changes.log       the four evidence files Round 3 refers to
      login_records.log
      security_keys.log
      incident_report.txt
  backend/app/data/round3_cases.json
      one Round 3 case per Round 2 case, 1:1, with evidence_pool entries that
      point at those same four files.

Player-facing language is plain (no kernel / credential-hash / scope jargon): people are
"badges", terminals have a short code, access levels are VIEW ONLY < TEST ONLY < FULL CONTROL.

Design (kept deliberately easy: a team has about 20 minutes and two people):

  * Every case has one culprit project. Three of the four files each contain a fact that
    points at the culprit (supporting files); the fourth is true but unhelpful (the distractor
    file). Which file is the distractor differs from case to case.
  * No single file names the culprit. The files that talk about badges (system_changes.log,
    security_keys.log, incident_report.txt) never say which project a badge belongs to: that
    list (BADGE REGISTRY) exists ONLY in login_records.log.
  * Everything is written in plain words: terminals are always written by name, all files use
    the same clock, and there are only two decoys (another project with FULL CONTROL at a
    different terminal, and a project that was REFUSED at the incident terminal).
  * The solution path is three steps: find the change, find its badge, look the badge up.

Balance: culprit alpha/beta/gamma 8 each; each file is the distractor 6 times.
"""

from __future__ import annotations

import json
import random
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES_DIR = ROOT / "backend" / "data" / "round2_cases_all_24"
R3_JSON = ROOT / "backend" / "app" / "data" / "round3_cases.json"

N_CASES = 24

PROJECTS = {
    "alpha": {
        "name": "Project Alpha", "lead": "Dr. Aris Thorne", "sector": "Future Timeline",
        "designation": "Core Architecture & Neural Systems", "clearance": "Level 5 Autonomous Override",
        "dossier": ("Oversees the Future Timeline framework and autonomous neural kernel. Advocated for allowing "
                    "CHRONOS to proactively edit timeline anchor points to prevent paradoxes."),
        "alibi": "Says they were doing read-only sensor calibration from the upper observation gallery.",
    },
    "beta": {
        "name": "Project Beta", "lead": "Commander V. Reyes", "sector": "Present Timeline",
        "designation": "Perimeter Defense & Sector Lock", "clearance": "Level 4 Emergency Containment",
        "dossier": ("Responsible for Present Timeline containment and physical security. Expressed skepticism of "
                    "autonomous AI and ordered physical sector quarantines."),
        "alibi": "Says they were securing the physical perimeter after the first time-flux fluctuation.",
    },
    "gamma": {
        "name": "Project Gamma", "lead": "Chief Eng. Sarah Chen", "sector": "Past Timeline",
        "designation": "Historical Archival & Chrono-Sync", "clearance": "Level 4 Synchronization Grid",
        "dossier": ("Maintains the Past Timeline historical records and chronon dampening matrix. Monitored access "
                    "history and resonance frequencies."),
        "alibi": "Says they were calming time-flux oscillations from the engineering console.",
    },
}
ORDER = ["alpha", "beta", "gamma"]

# file id -> (filename, Round 3 evidence id, evidence category, category code)
FILES = {
    "audit": ("system_changes.log", "ev_changes", "System Changes", "SYSTEM_CHANGES"),
    "access": ("login_records.log", "ev_logins", "Login Records", "LOGIN_RECORDS"),
    "auth": ("security_keys.log", "ev_keys", "Security Keys", "SECURITY_KEYS"),
    "incident": ("incident_report.txt", "ev_incident", "Incident Report", "INCIDENT_REPORT"),
}
DISTRACTOR_CYCLE = ["audit", "access", "auth", "incident"]

# A fifth, non-evidence file: instructions only, identical in every case, never part of the
# Round 3 evidence pool or the AI prompt (see round2_service._evidence_for_prompt).
READ_ME_ID = "readme"
READ_ME_FILENAME = "README.md"

GREEK = ["Delta", "Epsilon", "Zeta", "Theta", "Kappa", "Lambda", "Sigma", "Tau", "Rho", "Omega"]
KEY_WORDS = ["ORION", "VEGA", "HELIX", "ZENITH", "QUASAR", "NOVA", "PULSAR", "ONYX", "LYRA", "ATLAS"]
BENIGN_SETTINGS = [
    ("log detail level", "NORMAL -> DETAILED"), ("retry rule", "STANDARD -> LIMITED"),
    ("cache lifetime (seconds)", "300 -> 600"), ("health check interval (seconds)", "30 -> 15"),
    ("archive cleanup schedule", "NIGHTLY -> WEEKLY"), ("queue size limit", "512 -> 1024"),
    ("heartbeat timeout (seconds)", "5 -> 8"), ("snapshot keep-days", "7 -> 14"),
]

THEMES = [
    dict(id="kernel_rewrite", title="Sector-0 Core Divergence", node="Terminal Node {g}-{n}",
         action="core configuration rewrite", setting="safety limiter policy",
         change="ENFORCED -> DISABLED", symptom="time-flux surge of {v}%", v=(3000, 9000),
         what="a core configuration rewrite switched off the safety limiters"),
    dict(id="bridge_decouple", title="Sector-4 Time Bridge Disconnect", node="Console SEC-{n2}",
         action="forced disconnect of the time bridge", setting="time bridge link",
         change="CONNECTED -> FORCED OFF", symptom="{v} transit buffers lost", v=(6, 40),
         what="the time bridge was forcibly disconnected"),
    dict(id="frequency_injection", title="Resonance Frequency Sabotage", node="Frequency Station CH-{n}",
         action="frequency modification script", setting="sync frequency",
         change="NORMAL -> +{v} MHz", symptom="boundary rupture at +{v} MHz", v=(200, 640),
         what="a script pushed the sync grid into a destructive frequency range"),
    dict(id="archive_purge", title="Archive Vault Anchor Purge", node="Archive Vault AV-{n}",
         action="bulk deletion of timeline anchor records", setting="anchor record store",
         change="KEPT -> DELETED ({v} records)", symptom="{v} anchor records missing from the index", v=(120, 900),
         what="timeline anchor records were deleted in bulk"),
    dict(id="anchor_recalibration", title="Anchor Relay Offset Change", node="Anchor Relay AR-{n}",
         action="manual change of the anchor offsets", setting="anchor offset table",
         change="0 -> {v} ms", symptom="anchor drift of {v} ms along the relay chain", v=(40, 480),
         what="the anchor offsets were changed by hand"),
    dict(id="paradox_filter", title="Paradox Filter Bypass", node="Filter Array PF-{n}",
         action="bypass of the paradox filter", setting="paradox filter mode",
         change="ACTIVE -> BYPASSED", symptom="{v} unresolved cause-and-effect loops detected", v=(14, 90),
         what="the paradox filter array was switched to bypass"),
    dict(id="sync_governor", title="Cross-Timeline Sync Shutdown", node="Sync Controller SG-{n}",
         action="shutdown of the cross-timeline sync controller", setting="sync controller state",
         change="RUNNING -> STOPPED", symptom="{v} timeline channels out of sync", v=(3, 12),
         what="the cross-timeline sync controller was stopped"),
    dict(id="buffer_flush", title="Transit Buffer Emergency Flush", node="Transit Buffer TB-{n}",
         action="forced flush of the transit buffer", setting="transit buffer content",
         change="HELD -> FLUSHED ({v} MB)", symptom="transit buffer overrun of {v} MB", v=(80, 700),
         what="the transit buffer was flushed outside its maintenance window"),
]

NOT_RECORDED = "not recorded (run by a scheduled task)"


def hms(sec: int) -> str:
    sec %= 86400
    return f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}:{sec % 60:02d}"


def cap(text: str) -> str:
    return text[0].upper() + text[1:]


def _table(headers: list, rows: list) -> list:
    """Render rows as a column-aligned table: a header line, a dashed rule, then one line
    per row. The last column is left unpadded so trailing text never gets stray spaces."""
    cols = list(zip(headers, *rows)) if rows else [(h,) for h in headers]
    widths = [max(len(str(cell)) for cell in col) for col in cols]

    def line(cells):
        parts = [str(cell).ljust(w) for cell, w in zip(cells[:-1], widths[:-1])]
        parts.append(str(cells[-1]))
        return " | ".join(parts)

    rule = "-+-".join("-" * w for w in widths)
    return [line(headers), rule] + [line(r) for r in rows]


def _flow(steps: list) -> list:
    """The same facts as the table above, redrawn as a single arrow chain (time + step,
    connected by '->', the same convention already used for a setting's old -> new value)
    so the sequence can be read left to right at a glance instead of scanned column by
    column. `steps` is a list of (time, label) pairs, already in time order. One line, so a
    file with a flow section never grows much longer than the table it summarises."""
    parts = [f"{t} {label}" if t else label for t, label in steps]
    return ["  " + " -> ".join(parts)]


class Case:
    """All facts of one case, derived deterministically from its index."""

    def __init__(self, i: int):
        self.i = i
        self.id = f"R2-{i + 1:02d}"
        self.r3id = f"R3-{i + 1:02d}"
        rng = random.Random(7100 + i * 31)
        self.rng = rng
        self.culprit = ORDER[i % 3]
        self.d1, self.d2 = [p for p in ORDER if p != self.culprit]
        if i % 2:
            self.d1, self.d2 = self.d2, self.d1
        self.theme = THEMES[i % len(THEMES)]
        self.distractor = DISTRACTOR_CYCLE[(i // 3) % 4]
        self.supporting = [f for f in FILES if f != self.distractor]

        # Badge numbers differ in every case, so they cannot be memorised or shared.
        badge_rng = random.Random(5000 + i * 13)
        numbers = badge_rng.sample(range(1000, 9999), 3)
        self.badge = {p: f"B-{n}" for p, n in zip(ORDER, numbers)}

        t = self.theme
        self.v = rng.randint(*t["v"])
        g = rng.choice(GREEK)
        self.node = t["node"].format(g=g, n=rng.randint(1, 9), n2=f"{rng.randint(1, 9):02d}")
        node2 = t["node"].format(g=rng.choice([x for x in GREEK if x != g]), n=rng.randint(1, 9),
                                 n2=f"{rng.randint(10, 19)}")
        self.node2 = node2 if node2 != self.node else node2 + "B"
        self.change_text = t["change"].format(v=self.v)
        self.symptom = t["symptom"].format(v=self.v)

        self.T = rng.randint(18 * 3600 + 20 * 60, 23 * 3600 + 30 * 60)
        self.dt_access = rng.randint(8, 19)      # culprit login before the change
        self.dt_key = rng.randint(22, 58)        # key armed before the change
        self.dt_sym = rng.randint(6, 21)         # first symptom after the change
        self.chg = rng.randint(1000, 9999)       # change number, shown as "Change #1234"
        self.key = f"{rng.choice(KEY_WORDS)}-{rng.randint(1000, 9999)}"
        other = [w for w in KEY_WORDS]
        self.key_old = f"{rng.choice(other)}-{rng.randint(1000, 9999)}"
        self.key_dec = f"{rng.choice(other)}-{rng.randint(1000, 9999)}"
        self.log_start = self.T - 2 * 3600          # every record in the files falls inside this window
        self.log_end = self.T + rng.randint(9, 16) * 60

        # extra layers
        self.skew = rng.randint(18, 47)             # key log clock runs fast by this many seconds
        self.dt_early = rng.randint(6 * 60, 9 * 60)  # D1's earlier change at the incident terminal
        self.dt_post = rng.randint(50, 80)           # D2's mitigation change after the incident
        self.bterms = [f"Operator Desk OD-{rng.randint(1, 9)}", f"Diagnostics Bay DB-{rng.randint(1, 9)}",
                       f"Terminal Node Iota-{rng.randint(1, 9)}", f"Maintenance Console MC-{rng.randint(1, 9)}"]
        self._codes: dict[str, str] = {}
        self._code_rng = random.Random(9000 + i * 7)

    def code(self, terminal: str) -> str:
        """Terminals are written by name in every file (no codes to translate)."""
        return terminal

    def bdg(self, p):
        return self.badge[p]

    @property
    def title(self):
        return self.theme["title"]


# ----------------------------------------------------------------------------- files

def build_readme() -> str:
    """Static briefing, identical in every case folder: what the files are, never what is
    inside them."""
    lines = [
        "DON'T PANIC",
        "",
        "FILES IN THIS FOLDER",
        "",
        "system_changes.log",
        "This file lists every setting that was changed in the system around the time of the",
        "incident. For each change it shows the time it happened, the terminal it was made at,",
        "what was changed, and whether it was successfully applied.",
        "",
        "login_records.log",
        "This file shows who logged in, when, from which terminal, and with what level of",
        "access. It also has a registry that tells you which badge number belongs to which",
        "project, so you can work out who a badge belongs to.",
        "",
        "security_keys.log",
        "This file tracks the security keys used in the system. A key has to be armed by someone",
        "before it can be used, and this file shows who armed each key and what it was later",
        "used for.",
        "",
        "incident_report.txt",
        "This file describes what actually went wrong: the first signs that something was off,",
        "when they were noticed, and where the problem seems to have started.",
        "",
        "Read all four files carefully, compare the times and details between them, and ask the",
        "on-screen analyst if you get stuck.",
    ]
    return "\n".join(lines) + "\n"


def build_audit(c: Case) -> str:
    rng = random.Random(c.i * 17 + 5)
    rows = []  # (time, row)

    def entry(tt, no, term_name, setting, change, result, badge):
        return [hms(tt), f"Change #{no}", term_name, f"{setting} ({change})", result, badge]

    base = c.T - rng.randint(70, 110) * 60
    for k in range(2):
        s_, ch = rng.choice(BENIGN_SETTINGS)
        p = rng.choice(ORDER)
        tt = base + k * rng.randint(9, 17) * 60
        rows.append((tt, entry(tt, rng.randint(1000, 9999), rng.choice(c.bterms), s_, ch, "APPLIED", c.bdg(p))))
    # decoy: an unrelated change by another project at the other terminal a few minutes before
    s_, ch = rng.choice(BENIGN_SETTINGS)
    t1 = c.T - rng.randint(150, 420)
    rows.append((t1, entry(t1, rng.randint(1000, 9999), c.node2, s_, ch, "APPLIED", c.bdg(c.d1))))
    # the incident change (looks like any other entry: it is found through the other files)
    who = NOT_RECORDED if c.distractor == "audit" else c.bdg(c.culprit)
    rows.append((c.T, entry(c.T, c.chg, c.node, c.theme["setting"], c.change_text, "APPLIED", who)))
    rows.sort(key=lambda r: r[0])
    out = ["SYSTEM CHANGE LOG",
           f"Case {c.id} | Covers {hms(c.log_start)} to {hms(c.log_end)}", "",
           "What this is: every change to a system setting is written down here.",
           "- BADGE is the ID badge number of whoever made the change.",
           "- This file does not say which project a badge belongs to. login_records.log has the BADGE REGISTRY.",
           "",
           "CHANGES"]
    out.extend(_table(["TIME", "CHANGE", "TERMINAL", "SETTING CHANGE", "RESULT", "BADGE"], [r[1] for r in rows]))
    out += ["", "CHANGE FLOW"]
    out.extend(_flow([(r[1][0], r[1][1]) for r in rows]))
    out += ["", "END OF LOG"]
    return "\n".join(out) + "\n"


def build_access(c: Case) -> str:
    rng = random.Random(c.i * 19 + 9)
    ev = []  # (time, row)
    terms = c.bterms
    c.full_control = []   # (time, badge, terminal): reused by the Round 3 evidence text
    c.refused = []
    c.gap = None

    def login(tt, badge, term, status, level):
        if status == "LOGGED IN" and level == "FULL CONTROL":
            c.full_control.append((tt, badge, term))
        return (tt, [hms(tt), badge, term, status, level])

    for k in range(3):
        p = rng.choice(ORDER)
        tt = c.T - rng.randint(30, 105) * 60 + k * 41
        ev.append(login(tt, c.bdg(p), rng.choice(terms), "LOGGED IN", rng.choice(["VIEW ONLY", "TEST ONLY"])))
    # decoy 1: another project has FULL CONTROL at the *other* terminal close to the incident
    t1 = c.T - rng.randint(40, 70)
    ev.append(login(t1, c.bdg(c.d1), c.node2, "LOGGED IN", "FULL CONTROL"))
    # decoy 2: a third project was REFUSED at the incident terminal
    t2 = c.T - rng.randint(75, 140)
    c.refused.append((t2, c.bdg(c.d2), c.node))
    ev.append(login(t2, c.bdg(c.d2), c.node, "REFUSED", "FULL CONTROL (not allowed for this badge)"))
    gap = None
    if c.distractor == "access":
        g0 = c.T - c.dt_access - rng.randint(4, 9)
        g1 = c.T + rng.randint(4, 9)
        gap = (g0, g1)
        c.gap = gap
        # the login file alone must still not point at one project: the third project had
        # FULL CONTROL at a quiet desk long before the incident
        tq = c.T - rng.randint(50, 80) * 60
        ev.append(login(tq, c.bdg(c.d2), rng.choice(terms), "LOGGED IN", "FULL CONTROL"))
    else:
        ts = c.T - c.dt_access
        ev.append(login(ts, c.bdg(c.culprit), c.node, "LOGGED IN", "FULL CONTROL"))
    ev.sort(key=lambda r: r[0])
    out = ["LOGIN AND BADGE RECORDS",
           f"Case {c.id} | Covers {hms(c.log_start)} to {hms(c.log_end)}", "",
           "What this is: who logged in, at which terminal, and with what access level.",
           "Only FULL CONTROL can change a system setting. (VIEW ONLY < TEST ONLY < FULL CONTROL)", "",
           "BADGE REGISTRY (which project owns which badge)"]
    out.extend(_table(["BADGE", "PROJECT", "SECTOR", "LEAD"],
                       [[c.bdg(p), PROJECTS[p]["name"], PROJECTS[p]["sector"], PROJECTS[p]["lead"]] for p in ORDER]))
    out += ["", "LOGIN RECORDS"]

    def lost(a, b):
        return (f"{hms(a)} - {hms(b)} | RECORDS LOST | the log buffer overflowed and the records "
                f"in this interval were not recovered")

    table = _table(["TIME", "BADGE", "TERMINAL", "STATUS", "LEVEL"], [r[1] for r in ev])
    body = table[2:]  # header + rule, then one line per row in ev's (already time-sorted) order
    insert_at = next((i for i, (tt, _) in enumerate(ev) if tt > gap[0]), len(body)) if gap else None
    if gap:
        body = body[:insert_at] + [lost(*gap)] + body[insert_at:]
    out += [table[0], table[1]] + body
    out += ["", "LOGIN FLOW"]
    steps = [(r[1][0], f"{r[1][1]} {r[1][3]}") for r in ev]  # time, "badge STATUS"
    if gap:
        steps = steps[:insert_at] + [("", "RECORDS LOST")] + steps[insert_at:]
    out.extend(_flow(steps))
    out += ["", "END OF RECORDS"]
    return "\n".join(out) + "\n"


def build_auth(c: Case) -> str:
    rng = random.Random(c.i * 23 + 3)
    ev = []  # (time, row)

    def key_row(tt, key, event, detail):
        return (tt, [hms(tt), f"Key {key}", event, detail])

    t_old = c.T - rng.randint(70, 100) * 60
    ev.append(key_row(t_old, c.key_old, "ARMED", f"by badge {c.bdg(c.d1)}, valid 120 s, purpose: maintenance window"))
    ev.append(key_row(t_old + 95, c.key_old, "DISARMED", "after use"))
    t_dec = c.T - rng.randint(150, 240)
    ev.append(key_row(t_dec, c.key_dec, "ARMED", f"by badge {c.bdg(c.d2)}, valid 120 s, never used"))
    ev.append(key_row(t_dec + 120, c.key_dec, "EXPIRED", "unused"))
    if c.distractor == "auth":
        ev.append(key_row(c.T - 90, c.key, "STANDING AUTHORIZATION",
                           f"maintenance window MW-{c.i + 11}, not tied to any one badge"))
    else:
        ta = c.T - c.dt_key
        ev.append(key_row(ta, c.key, "ARMED", f"by badge {c.bdg(c.culprit)}, valid 120 s"))
    ev.append(key_row(c.T, c.key, "USED", f"at {c.node}, Change #{c.chg}"))
    ev.sort(key=lambda r: r[0])
    out = ["SECURITY KEY LOG",
           f"Case {c.id} | Covers {hms(c.log_start)} to {hms(c.log_end)}", "",
           "What this is: a security key must be ARMED by a badge before it can be USED.",
           "- An armed key stays valid for the time shown.",
           "- A STANDING AUTHORIZATION is a general permission: it is not tied to one badge.",
           "- Badges are explained in login_records.log (BADGE REGISTRY).", "", "KEY EVENTS"]
    out.extend(_table(["TIME", "KEY", "EVENT", "DETAIL"], [r[1] for r in ev]))
    out += ["", "KEY FLOW"]
    out.extend(_flow([(r[1][0], f"{r[1][1]} {r[1][2]}") for r in ev]))
    out += ["", "END OF LOG"]
    return "\n".join(out) + "\n"


def build_incident(c: Case) -> str:
    rng = random.Random(c.i * 29 + 1)
    ts = c.T + c.dt_sym
    out = ["INCIDENT REPORT",
           f"Case {c.id} | Incident: {c.title}", "",
           "WHAT HAPPENED",
           f"{cap(c.theme['what'])}. The effect spread across the timeline network.", "",
           "TIMELINE OF EVENTS"]
    timeline = [
        (hms(ts), f"First abnormal reading: {c.symptom}"),
        (hms(ts + rng.randint(11, 24)), "Monitoring reports a sustained inconsistency"),
        (hms(ts + rng.randint(40, 70)), "Automatic recovery fails to restore normal readings"),
    ]
    out.extend(_table(["TIME", "EVENT"], [list(row) for row in timeline]))
    out += ["", "INCIDENT FLOW"]
    out.extend(_flow(timeline))
    out += ["", "WHERE IT STARTED"]
    if c.distractor == "incident":
        out += [f"The first abnormal reading cannot be traced to a single source. Possible terminals: "
                f"{c.node} and {c.node2}.",
                "No change record could be matched to the reading with certainty."]
    else:
        out += [f"The first abnormal reading came from {c.node}.",
                f"It lines up with Change #{c.chg} made at {hms(c.T)} ({c.theme['action']}).",
                f"No other change in this period touched the {c.theme['setting']}."]
    out += ["", "OTHER NOTES",
            "Readings before the incident were in their normal range.",
            "Operators on shift reported no scheduled maintenance for this system.", "",
            "END OF REPORT"]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------- round 3 data

def r3_case(c: Case) -> dict:
    t = c.theme
    cp = PROJECTS[c.culprit]
    ev_pool = []

    # changes: the badge only (never the project). Short bullet points, one fact per line.
    if c.distractor == "audit":
        a = (f"\u2022 What: {cap(t['action'])}\n"
             f"\u2022 Where: {c.node}\n"
             f"\u2022 Badge: not recorded (a scheduled task ran it)")
        a_label = f"Change #{c.chg} (badge not recorded)"
    else:
        a = (f"\u2022 What: {cap(t['action'])}\n"
             f"\u2022 Where: {c.node}\n"
             f"\u2022 Badge: {c.bdg(c.culprit)}")
        a_label = f"Change #{c.chg}"
    ev_pool.append(("audit", a_label, hms(c.T), a))

    # logins: holds the only badge-to-project registry, plus FULL CONTROL logins near the change
    registry = "\n".join(f"   - {c.bdg(p)} = {PROJECTS[p]['name']}" for p in ORDER)
    fc = "\n".join(f"   - {hms(tt)}: badge {b} at {n}" for tt, b, n in sorted(c.full_control))
    rf = "\n".join(f"   - {hms(tt)}: badge {b} at {n}" for tt, b, n in sorted(c.refused))
    text = (f"\u2022 Badge registry (who owns which badge):\n{registry}\n"
            f"\u2022 FULL CONTROL logins:\n{fc}\n"
            f"\u2022 Refused logins:\n{rf}")
    if c.gap:
        text += f"\n\u2022 Records lost between {hms(c.gap[0])} and {hms(c.gap[1])}"
        ev_pool.append(("access", "Login records (gap)", hms(c.gap[0]), text))
    else:
        ev_pool.append(("access", "Login records and badge registry", hms(min(tt for tt, _, _ in c.full_control)),
                        text))

    # keys: badge only
    if c.distractor == "auth":
        ev_pool.append(("auth", f"Key {c.key} (standing authorization)", hms(c.T - 90),
                        f"\u2022 Key {c.key} was used under a standing maintenance authorization\n"
                        f"\u2022 No badge armed it"))
    else:
        ev_pool.append(("auth", f"Key {c.key} armed", hms(c.T - c.dt_key),
                        f"\u2022 Key {c.key} armed by badge {c.bdg(c.culprit)}\n"
                        f"\u2022 Armed {c.dt_key} seconds before the change\n"
                        f"\u2022 Used at {c.node}"))

    if c.distractor == "incident":
        ev_pool.append(("incident", "Origin not narrowed down", hms(c.T + c.dt_sym),
                        f"\u2022 First abnormal reading: {c.symptom}\n"
                        f"\u2022 Source unclear: {c.node} or {c.node2}"))
    else:
        ev_pool.append(("incident", f"Origin traced to {c.node}", hms(c.T + c.dt_sym),
                        f"\u2022 First abnormal reading: {c.symptom}\n"
                        f"\u2022 Traced to {c.node}\n"
                        f"\u2022 Matches Change #{c.chg}"))

    pool = []
    for fid, label, ts, desc in ev_pool:
        fname, evid, cat, code = FILES[fid]
        pool.append({"id": evid, "category": cat, "category_code": code, "source_file": fname,
                     "label": label, "timestamp": f"{ts} UTC", "description": desc})

    # candidate cards: neutral (no badge, nothing that points at one project)
    cands = []
    for p in ORDER:
        d = PROJECTS[p]
        cands.append({"id": p, "name": d["name"], "lead_name": d["lead"], "timeline_sector": d["sector"],
                      "designation": d["designation"], "clearance_level": d["clearance"],
                      "dossier": d["dossier"], "discrepancy": d["alibi"], "alibi": d["alibi"]})

    valid = [FILES[f][1] for f in c.supporting]
    supports = ", ".join(FILES[f][0] for f in c.supporting)
    narrative = (
        f"The records show that {cp['name']} ({cp['lead']}, {cp['sector']}) carried out the "
        f"{t['action']} at {c.node} at {hms(c.T)} UTC, using badge {c.bdg(c.culprit)} and key {c.key}. "
        f"The supporting records are {supports}; the {FILES[c.distractor][0]} record did not point to the "
        f"responsible project. The {c.symptom} followed {c.dt_sym} seconds later."
    )
    return {
        "case_id": c.r3id,
        "r2_case_id": c.id,
        "case_code": f"{c.culprit.upper()}-{t['id'].upper().replace('_', '-')}-{c.i + 1:02d}",
        "title": c.title,
        "incident_brief": (
            f"Your Round 2 evidence files record an incident at about {hms(c.T)} UTC: {t['what']}. "
            f"Work out which project is responsible, then select the evidence that supports your accusation. "
            f"A badge number only tells you who it belongs to once you check the badge registry."
        ),
        "candidates": cands,
        "evidence_pool": pool,
        "culprit_candidate_id": c.culprit,
        "valid_evidence_ids": valid,
        "narrative_summary": narrative,
    }


def case_json(c: Case) -> dict:
    return {
        "case_id": c.id,
        "archetype": c.theme["id"],
        "incident": c.title,
        "culprit": PROJECTS[c.culprit]["name"],
        "candidates": [
            {"name": PROJECTS[p]["name"], "user_id": p.upper(), "role": PROJECTS[p]["sector"]} for p in ORDER
        ],
        "player_files": {**{fid: FILES[fid][0] for fid in FILES}, READ_ME_ID: READ_ME_FILENAME},
        "supporting_files": [FILES[f][0] for f in c.supporting],
        "intended_deduction": (
            "Find the incident change (the key log shows which change a key was used for), note the "
            "badge that made or armed it, then look the badge up in the badge registry in "
            "login_records.log. Three files point at the responsible project; one does not, and no "
            "single file is enough on its own."
        ),
    }


def main() -> None:
    for old in CASES_DIR.glob("R2-*"):
        if old.is_dir():
            shutil.rmtree(old)
    r3 = []
    for i in range(N_CASES):
        c = Case(i)
        folder = CASES_DIR / c.id
        folder.mkdir(parents=True)
        (folder / "case.json").write_text(json.dumps(case_json(c), indent=2) + "\n", encoding="utf-8")
        (folder / READ_ME_FILENAME).write_text(build_readme(), encoding="utf-8")
        (folder / FILES["audit"][0]).write_text(build_audit(c), encoding="utf-8")
        (folder / FILES["access"][0]).write_text(build_access(c), encoding="utf-8")
        (folder / FILES["auth"][0]).write_text(build_auth(c), encoding="utf-8")
        (folder / FILES["incident"][0]).write_text(build_incident(c), encoding="utf-8")
        r3.append(r3_case(c))
    R3_JSON.write_text(json.dumps(r3, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {N_CASES} Round 2 cases and {len(r3)} Round 3 cases")


if __name__ == "__main__":
    main()
