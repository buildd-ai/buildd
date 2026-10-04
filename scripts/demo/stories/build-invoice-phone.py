#!/usr/bin/env python3
"""Generates the invoice-phone demo story for the v7 film (fully fictional): python3 build-invoice-phone.py [out.json]

A visual UI fix: the Harborline invoices table overflows on phones. One runner
works three tasks at once; one agent asks a question that reaches a phone; the
fix's own check (a Playwright no-overflow test, the task's loop exit condition)
fails on the first attempt, sends it back, and passes on the second.

Default output: invoice-phone.json next to this file. Edit here and re-run;
never hand-edit the JSON. Shapes follow build-multi-currency.py."""
import json, os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "invoice-phone.json")
HERE = os.path.dirname(os.path.abspath(__file__))

REPO_SLUG = "harborline/billing-web"
REPO_URL = f"https://github.com/{REPO_SLUG}"
def pr_url(n): return f"{REPO_URL}/pull/{n}"

SHORT = {"T0": "b71e4c20", "T1": "3a9d6f51", "T2": "e40c2b87", "T3": "8f15a3d9", "VA": "c62b9e04", "V1": "1d7f8a36", "V2": "94e2c5b1"}
MISSION_SHORT = "6c3e9a12"

def slug(title):
    import re
    return re.sub(r"[^a-z0-9]+", "-", title.lower())[:30]

def branch(tkey, title):
    return f"buildd/{SHORT[tkey]}-{slug(title)}"

ACCOUNT_NAME = "harborline-fleet"

team = {"key": "team", "table": "teams", "name": "Harborline", "slug": "harborline", "timezone": "America/Chicago"}
users = [{"key": "u_maya", "table": "users", "name": "Maya Okafor", "email": "maya@harborline.example",
          "_note": "fictional eng lead; answers the question from her phone"}]
accounts = [{"key": "acct_fleet", "table": "accounts", "type": "user", "level": "worker", "name": ACCOUNT_NAME, "authType": "oauth",
             "maxConcurrentWorkers": 3, "apiKey": "bld_demo_0000000000000000000000000000", "apiKeyPrefix": "bld_demo"}]
# One runner, three concurrent tasks.
runners = [{"key": "atlas", "table": "worker_heartbeats", "runner": "atlas", "localUiUrl": "http://atlas.local:8766",
            "maxConcurrentWorkers": 3, "_display": "atlas · Mac Studio"}]

workspace = {
    "key": "ws", "table": "workspaces", "name": "billing-web", "repo": REPO_URL, "accessMode": "restricted", "dataClass": "standard",
    "maxConcurrentTasks": 3, "configStatus": "admin_confirmed",
    "projects": [{"name": "web", "path": "apps/web", "description": "Customer portal + admin (Next.js)", "color": "#D4724A"}],
    "gitConfig": {"defaultBranch": "main", "branchingStrategy": "trunk", "useBuildBranch": True, "branchStrategy": "direct",
                  "commitStyle": "conventional", "requiresPR": True, "targetBranch": "main", "autoCreatePR": True, "useClaudeMd": True,
                  "criteriaGrader": "runner"},
    "_github": {"table": "github_repos", "fullName": REPO_SLUG},
}

ROLE_BODY = "# {name}\n\n(Seed with the stock body from apps/web/src/lib/default-roles.ts.)\n"
roles = [
    {"key": "organizer", "slug": "organizer", "name": "Organizer", "color": "#6366F1", "model": "sonnet", "canDelegateTo": ["builder"], "description": "Plans missions into tasks and keeps them moving"},
    {"key": "builder", "slug": "builder", "name": "Builder", "color": "#0C72CB", "model": "opus", "canDelegateTo": [], "description": "Writes code, opens PRs, fixes its own CI"},
    {"key": "visual-auditor", "slug": "visual-auditor", "name": "Visual Auditor", "color": "#14B8A6", "model": "sonnet", "canDelegateTo": [],
     "allowedTools": ["Read", "Grep", "Glob", "Bash", "AskUserQuestion", "mcp__buildd__buildd"],
     "description": "Screenshots the pages a mission changed at phone and desktop width, judges each shot, and files fix tasks. Never edits code or opens PRs"},
]
for r in roles:
    r.update({"table": "workspace_skills", "isRole": True, "enabled": True, "origin": "manual",
              "content": ROLE_BODY.format(name=r["name"]), "contentHash": "<sha256 of content>", "workspaceId": "ws"})
    r.setdefault("allowedTools", [])

# ---------------------------------------------------------------- the mission
M1_TITLE = "Invoice table fits on phones"
M1_ASK = "The invoice table overflows on phones."
OVERFLOW_TEST = "pnpm playwright test invoices-phone --grep 'no horizontal overflow at 390px'"
SCROLL_TEST = "pnpm playwright test invoices-scroll"
mission = {
    "key": "M1", "table": "missions", "workspaceId": "ws", "createdByUserId": "u_maya",
    "title": M1_TITLE, "description": M1_ASK,
    "status": "active", "_statusAtEnd": "completed", "priority": 5, "orchestrationMode": "auto", "maxConcurrentTasks": 3,
    "defaultOutputRequirement": "pr_required", "pacingMode": "eager",
    "mergePolicy": {"tier": "auto-threshold", "threshold": {"maxLines": 800}},
    "integrationBranchEnabled": False, "workingBranch": None, "autoVerify": True, "autoSurfaceAudit": True, "scheduleId": None,
    "goalCriteria": [
        {"type": "command", "command": OVERFLOW_TEST, "label": "Fits a 390px screen"},
        {"type": "command", "command": SCROLL_TEST, "label": "No sideways scroll on /invoices"},
        # Approval is a person's call in the visual review, so this one is prose, graded on the record.
        {"type": "description", "label": "Phone screenshot approved",
         "description": "A person approves the phone screenshot of /invoices in the mission's visual review.",
         "notMechanizableReason": "Whether the phone layout looks right is a person's judgment; the review records it."},
    ],
    "goalCriteriaState": None, "_idShort": MISSION_SHORT,
}

def task(key, title, role, kind, deps, **kw):
    t = {"key": key, "table": "tasks", "workspaceId": "ws", "missionId": "M1", "title": title, "description": kw.pop("description", ""),
         "status": "pending", "_statusAtEnd": kw.pop("statusAtEnd", "completed"), "priority": kw.pop("priority", 0),
         "mode": kw.pop("mode", "execution"), "roleSlug": role, "kind": kind, "complexity": kw.pop("complexity", "simple"),
         "missionPhaseIndex": None, "missionPhaseLabel": None, "dependsOn": deps,
         "outputRequirement": kw.pop("outputRequirement", "pr_required"), "creationSource": kw.pop("creationSource", "mcp"),
         "createdByWorkerId": kw.pop("createdByWorkerId", "w0"), "taskClass": kw.pop("taskClass", "work"), "backend": "claude",
         "project": kw.pop("project", "web"), "pathManifest": kw.pop("pathManifest", None), "_idShort": SHORT[key]}
    t.update(kw)
    return t

tasks = [
    task("T0", f"Mission: {M1_TITLE}", "organizer", "coordination", [], mode="planning", outputRequirement="none",
         creationSource="orchestrator", createdByWorkerId=None, taskClass="bookkeeping", project=None,
         description="Plan the mission into tasks."),
    # The fix carries its own check: its loop exit condition is the overflow test.
    task("T1", "fix(invoices): stack invoice rows as cards on phones", "builder", "engineering", [],
         pathManifest=["apps/web/src/app/invoices/InvoiceTable.tsx", "apps/web/src/app/invoices/invoices.css"],
         loopConfig={"exitCondition": {"type": "command", "command": OVERFLOW_TEST}, "maxLoops": 3},
         description="Under 640px, render each invoice as a card (number, status, customer, total, dates) instead of a table row."),
    task("T2", "fix(invoices): hide the Tax column when it is empty", "builder", "engineering", [],
         pathManifest=["apps/web/src/app/invoices/InvoiceTable.tsx"],
         description="Every invoice on this account has no tax line; the column only takes width."),
    task("T3", "test(e2e): no sideways scroll on /invoices at 390px", "builder", "engineering", [],
         pathManifest=["tests/e2e/invoices-scroll.spec.ts"],
         description="Playwright at 390x844: document.scrollingElement.scrollWidth must not exceed the viewport."),
    task("VA", "Visual review: /invoices at phone width", "visual-auditor", None, ["T1", "T2"],
         outputRequirement="artifact_required", creationSource="orchestrator", createdByWorkerId=None,
         context={"visualQa": {"requiredRoutes": ["/invoices"]}},
         description="Capture `/invoices` at phone (390x844) and desktop (1280x900), judge every shot. Read-only: no edits, no PR."),
    task("V1", "Verify goal criterion: Fits a 390px screen", None, "observation", [], outputRequirement="none", taskClass="bookkeeping",
         creationSource="orchestrator", createdByWorkerId=None, priority=2, tier="budget", project=None,
         loopConfig={"exitCondition": {"type": "command", "command": OVERFLOW_TEST}, "maxLoops": 1},
         description="Run the command and report. Do not change code."),
    task("V2", "Verify goal criterion: No sideways scroll on /invoices", None, "observation", [], outputRequirement="none", taskClass="bookkeeping",
         creationSource="orchestrator", createdByWorkerId=None, priority=2, tier="budget", project=None,
         loopConfig={"exitCondition": {"type": "command", "command": SCROLL_TEST}, "maxLoops": 1},
         description="Run the command and report. Do not change code."),
]
LABELS = {"T0": "plan the mission", "T1": "rows as cards", "T2": "hide empty Tax", "T3": "no sideways scroll",
          "VA": "visual review", "V1": "verify 390px fit", "V2": "verify no scroll"}
for t in tasks:
    t["label"] = LABELS[t["key"]]
def title_of(k): return next(t["title"] for t in tasks if t["key"] == k)

PRS = {"T1": (512, 96, 41, 3, 3), "T2": (513, 14, 6, 1, 1), "T3": (514, 38, 0, 1, 1)}
# T1 runs twice: w1 is attempt 1 (the check sends it back), w1b is attempt 2 on the same branch.
WK = {"T0": "w0", "T1": "w1", "T2": "w2", "T3": "w3", "VA": "wva", "V1": "wv1", "V2": "wv2"}

workers = []
def mk_worker(tk, wk, **kw):
    w = {"key": wk, "table": "workers", "taskId": tk, "workspaceId": "ws", "accountId": "acct_fleet",
         "name": f"{ACCOUNT_NAME}-{SHORT[tk]}", "runner": "atlas", "branch": branch(tk, title_of(tk)),
         "status": "idle", "_statusAtEnd": "completed", "waitingFor": None, "currentAction": None, "milestones": [],
         "prUrl": None, "prNumber": None, "prLifecycleStatus": None, "mergedAt": None,
         "commitCount": 0, "filesChanged": 0, "linesAdded": 0, "linesRemoved": 0, "costUsd": "0", "inputTokens": 0, "outputTokens": 0, "turns": 0}
    w.update(kw)
    return w
for tk, wk in WK.items():
    workers.append(mk_worker(tk, wk))
n, a, r, f, c = PRS["T1"]
workers.append(mk_worker("T1", "w1b", _final={"prNumber": n, "prUrl": pr_url(n), "linesAdded": a, "linesRemoved": r, "filesChanged": f,
                                                "commitCount": c, "prLifecycleStatus": "merged"}))
for tk in ("T2", "T3"):
    n, a, r, f, c = PRS[tk]
    next(w for w in workers if w["key"] == WK[tk])["_final"] = {"prNumber": n, "prUrl": pr_url(n), "linesAdded": a, "linesRemoved": r,
                                                                "filesChanged": f, "commitCount": c, "prLifecycleStatus": "merged"}

# ---------------------------------------------------------------- artifacts
SHOTS_DIR = os.path.join(HERE, "shots")
def shot(key, worker, fname, route, verdict, finding, run_key):
    return {"key": key, "table": "artifacts", "workerId": worker, "workspaceId": "ws", "missionId": "M1",
            "type": "screenshot", "key_": None, "title": fname, "content": None, "visibility": "private", "_file": f"shots/{fname}",
            "metadata": {"qa": {"runKey": run_key, "route": route, "viewport": "mobile", "finding": finding, "verdict": verdict},
                         "filename": fname, "mimeType": "image/png", "sizeBytes": os.path.getsize(os.path.join(SHOTS_DIR, fname))}}
artifacts = [
    # Attempt 1's evidence: the table still runs off a 390px screen.
    shot("a_before", "w1", "invoices-list-mobile-before.png", "/invoices", "broken",
         "/invoices at 390px: the table is 760px wide, so Due, Tax, Total and Status are off screen and the page scrolls sideways.", "harborline-invoices-r1"),
    # The visual review after attempt 2.
    # "unsure": the auditor sees no overflow, but whether the phone layout reads right is a person's call
    # (criterion 3), so the shot waits in the review deck for a Looks right.
    shot("a_after", "wva", "invoices-list-mobile-after.png", "/invoices", "unsure",
         "/invoices at 390px: no sideways scroll, and each invoice is a card. Whether the cards read right is a person's call.", "harborline-invoices-r2"),
    {"key": "a_summary", "table": "artifacts", "workerId": None, "workspaceId": "ws", "missionId": "M1",
     "type": "summary", "key_": "mission-summary", "title": "Invoice table fits on phones",
     "content": "On phones each invoice is a card, and the empty Tax column is hidden. A Playwright test keeps /invoices from scrolling sideways at 390px.\n\n"
                "3 PRs merged · the first fix failed its overflow check and went back · you answered one question and approved the phone screenshot.",
     "visibility": "private", "metadata": {}},
]
for x in artifacts:
    x["key"], x["artifactKey"] = x.pop("key"), x.pop("key_")

# ---------------------------------------------------------------- notes
Q_TEXT = "Hide the empty Tax column on phones?"
mission_notes = [
    {"key": "n_plan", "table": "mission_notes", "missionId": "M1", "taskId": "T0", "workerId": "w0", "authorType": "agent", "type": "decision",
     "title": "Plan: 3 tasks, one runner", "body": "Stack rows as cards under 640px; hide the Tax column when it is empty; a Playwright test for sideways scroll at 390px.",
     "actorLabel": "Organizer", "status": "open"},
    {"key": "n_q", "table": "mission_notes", "missionId": "M1", "taskId": "T2", "workerId": "w2", "authorType": "agent", "type": "question",
     "title": Q_TEXT,
     # The options carry Yes and No (and what each does); the body says only why it asks.
     "body": "No invoice on this account has a tax line, so the Tax column is empty everywhere. On a phone it only takes width.",
     "defaultChoice": "Yes", "actorLabel": "Builder", "status": "open", "_statusAtEnd": "answered"},
    {"key": "n_reply", "table": "mission_notes", "missionId": "M1", "taskId": "T2", "workerId": "w2", "authorType": "user", "type": "reply",
     "replyTo": "n_q", "title": "Yes", "body": "Yes, hide it while it's empty.", "actorLabel": "Maya Okafor", "status": "open"},
    {"key": "n_done", "table": "mission_notes", "missionId": "M1", "taskId": None, "workerId": None, "authorType": "system", "type": "update",
     "title": "All 3 goal criteria pass, mission complete", "body": None, "actorLabel": "buildd", "status": "open"},
]

# ---------------------------------------------------------------- timeline
TL = []
def ev(t, op, **kw): TL.append({"t": t, "op": op, **kw})
def claim(t, tk, wk=None):
    wk = wk or WK[tk]
    ev(t, "claim", task=tk, worker=wk, runner="atlas", api="POST /api/workers/claim", db="tasks.status=assigned; INSERT workers")
    ev(t + 2, "worker_status", worker=wk, status="running", api=f"PATCH /api/workers/{wk} {{status:'running'}}", db="workers.status=running")
def prog(t, wk, pct, msg):
    ev(t, "progress", worker=wk, pct=pct, message=msg, api="MCP buildd update_progress", db="workers.milestones")
def complete(t, tk, wk, summary):
    ev(t, "complete", task=tk, worker=wk, summary=summary, api="MCP buildd complete_task {summary}", db="tasks.status=completed")
def open_pr(t, tk, wk):
    n, a, r, f, c = PRS[tk]
    ev(t, "pr_open", worker=wk, prNumber=n, prUrl=pr_url(n), title=title_of(tk), linesAdded=a, linesRemoved=r, filesChanged=f, commitCount=c,
       api="MCP buildd create_pr", db="workers.prUrl, prNumber")
def ci(t, tk, wk, state):
    ev(t, "ci", worker=wk, prNumber=PRS[tk][0], state=state, api="GitHub webhook", db=f"workers.prLifecycleStatus={state}")
def merge(t, tk, wk):
    ev(t, "merge", worker=wk, prNumber=PRS[tk][0], api="auto-merge on CI green", db="workers.mergedAt")

ev(0, "mission_create", mission="M1", title=M1_TITLE, description=M1_ASK, conversation="C1",
   api="chat approval confirmed → POST /api/missions", db="INSERT missions", beat="Confirm")
ev(2, "task_create", task="T0", api="mission create starts the organizer", db="INSERT tasks")
claim(4, "T0")
prog(8, "w0", 30, "Reading apps/web/src/app/invoices: InvoiceTable renders a 7-column <table> at 760px")
prog(18, "w0", 80, "Plan: cards under 640px, hide the empty Tax column, a 390px sideways-scroll test")
for i, k in enumerate(["T1", "T2", "T3"]):
    ev(24 + i, "task_create", task=k, api="MCP buildd create_task", db="INSERT tasks")
ev(27, "mission_note", note="n_plan", api="MCP buildd post_note", db="INSERT mission_notes")
complete(29, "T0", "w0", "Planned 3 tasks. All three can start now.")
claim(31, "T1"); claim(32, "T2"); claim(33, "T3")
TL[-1]["beat"] = "One runner, three tasks"
prog(45, "w1", 20, "InvoiceTable: a <table> with min-width: 760px")
prog(50, "w2", 25, "Checking the Tax column across this account's invoices")
prog(55, "w3", 30, "Playwright at 390x844: compare scrollWidth with the viewport")
prog(70, "w2", 45, "Every invoice here has no tax line: the column is empty everywhere")
ev(84, "waiting_input", worker="w2", task="T2", note="n_q",
   waitingFor={"type": "question", "prompt": Q_TEXT, "options": [
       {"label": "Yes", "description": "Hide it on phones while it is empty (it comes back when any invoice has tax)."},
       {"label": "No", "description": "Keep it."}]},
   api="PATCH /api/workers/w2 {status:'waiting_input', waitingFor} + post_note {type:'question'}",
   db="workers.status=waiting_input; INSERT mission_notes(type=question); push 'Agent needs your input'", beat="One question reaches the phone")
prog(95, "w1", 55, "Under 640px each row renders as a card: number, status, customer, total, dates")
prog(110, "w3", 70, "invoices-scroll.spec.ts: fails on main as expected (760px > 390px)")
ev(150, "human_reply", worker="w2", task="T2", note="n_reply", from_="u_maya", channel="phone", message="Yes, hide it while it's empty.",
   api="POST /api/workers/w2/respond", db="n_q answered; worker resumes", beat="Answered from the phone")
ev(153, "worker_status", worker="w2", status="running", api="PATCH /api/workers/w2", db="workers.status=running")
prog(170, "w2", 80, "Tax column hidden on phones while every invoice's tax is empty")
open_pr(190, "T3", "w3"); complete(196, "T3", "w3", "Playwright test: no sideways scroll on /invoices at 390px.")
ci(198, "T3", "w3", "ci_running"); ci(240, "T3", "w3", "ci_green"); merge(250, "T3", "w3")
open_pr(205, "T2", "w2"); complete(212, "T2", "w2", "The Tax column is hidden on phones while it is empty.")
ci(214, "T2", "w2", "ci_running"); ci(256, "T2", "w2", "ci_green"); merge(266, "T2", "w2")
# Attempt 1: the agent says done; its exit condition (the overflow test) says no.
prog(205, "w1", 90, "Rows render as cards on phones")
ev(228, "artifact", artifact="a_before", worker="w1", api="MCP buildd upload_artifact {type:'screenshot'}", db="INSERT artifacts")
complete(232, "T1", "w1", "Rows stack as cards on phones.")
TL[-1]["beat"] = "The agent says done"
ev(240, "loop_eval", task="T1", worker="w1", satisfied=False,
   summary="invoices-phone: /invoices is 760px wide at 390px. The cards wrapper keeps the table's min-width, so Due, Tax, Total and Status are off screen.",
   evidence={"output": "✗ no horizontal overflow at 390px\n  expected scrollWidth <= 390, received 760", "durationMs": 4210},
   api="loop-dispatcher: exit condition evaluated → loopState condition_unmet, task re-queued", db="tasks.loopState=condition_unmet, loopIteration=1, status=pending",
   beat="The check says no")
# Attempt 2, same branch.
claim(252, "T1", "w1b")
TL[-1]["beat"] = "Sent back: attempt 2"
prog(265, "w1b", 40, "The overflow test failed: the cards wrapper kept min-width: 760px from the table styles")
prog(290, "w1b", 80, "Removed the min-width under 640px; cards fill the screen")
open_pr(312, "T1", "w1b"); complete(318, "T1", "w1b", "Cards fit a 390px screen; nothing scrolls sideways.")
ev(326, "loop_eval", task="T1", worker="w1b", satisfied=True, summary="invoices-phone: no horizontal overflow at 390px (scrollWidth 390).",
   evidence={"output": "✓ no horizontal overflow at 390px", "durationMs": 3980},
   api="loop-dispatcher: exit condition met → loopState satisfied", db="tasks.loopState=satisfied, loopIteration=2", beat="Second try, it fits")
ci(320, "T1", "w1b", "ci_running"); ci(360, "T1", "w1b", "ci_green"); merge(372, "T1", "w1b")
ev(374, "task_create", task="VA", api="mission surface audit → INSERT tasks(roleSlug=visual-auditor)", db="INSERT tasks")
claim(376, "VA")
prog(384, "wva", 40, "Captured /invoices at phone and desktop width")
ev(392, "artifact", artifact="a_after", worker="wva", api="MCP buildd upload_artifact {type:'screenshot'}", db="INSERT artifacts")
complete(398, "VA", "wva", "Visual review: /invoices fits a 390px screen; the phone layout waits for your look.")
ev(402, "criteria_eval", mission="M1",
   state={"overall": "PENDING", "criteria": [
       {"index": 0, "type": "command", "label": "Fits a 390px screen", "verdict": "PENDING", "evidence": "verifying on runner…", "workerTaskId": "V1"},
       {"index": 1, "type": "command", "label": "No sideways scroll on /invoices", "verdict": "PENDING", "evidence": "verifying on runner…", "workerTaskId": "V2"},
       {"index": 2, "type": "description", "label": "Phone screenshot approved", "verdict": "PENDING", "evidence": "waiting for the visual review"}]},
   api="mission evaluate → goalCriteriaState", db="UPDATE missions.goalCriteriaState")
claim(404, "V1"); claim(405, "V2")
complete(430, "V1", "wv1", "Command exited 0."); complete(433, "V2", "wv2", "Command exited 0.")
ev(436, "criteria_eval", mission="M1",
   state={"overall": "PENDING", "criteria": [
       {"index": 0, "verdict": "pass", "evidence": "Command exited with code 0"}, {"index": 1, "verdict": "pass", "evidence": "Command exited with code 0"},
       {"index": 2, "verdict": "PENDING", "evidence": "waiting for the visual review"}]},
   api="verification results → goalCriteriaState", db="UPDATE missions.goalCriteriaState")
ev(500, "criteria_eval", mission="M1",
   state={"overall": "pass", "criteria": [{"index": 0, "verdict": "pass"}, {"index": 1, "verdict": "pass"},
                                          {"index": 2, "verdict": "pass", "evidence": "Maya Okafor: Looks right"}]},
   api="visual review approved → goalCriteriaState.overall=pass", db="UPDATE missions.goalCriteriaState")
ev(504, "artifact", artifact="a_summary", api="mission completion", db="INSERT artifacts")
ev(506, "mission_note", note="n_done", api="(system)", db="INSERT mission_notes")
ev(510, "mission_complete", mission="M1", api="missions.status=completed", db="missions.status=completed", beat="Done")

for e in TL:
    if e.get("beat") is None: e.pop("beat", None)
    if "from_" in e: e["from"] = e.pop("from_")
TL.sort(key=lambda e: e["t"])

# ---------------------------------------------------------------- the chat that files M1
M1_DRAFT = {"action": "create", "workspaceId": "{{ws}}", "title": M1_TITLE, "description": M1_ASK,
            "goalCriteria": mission["goalCriteria"], "maxConcurrentTasks": 3}
def tool_part(call_id, action, inp, summary):
    return {"type": f"tool-{action}", "toolCallId": call_id, "state": "output-available", "input": inp,
            "output": {"data": summary, "objects": [], "summary": summary}}
chat = {
    "capabilities": ["chat"],
    "providerKey": {"provider": "anthropic", "value": "sk-ant-demo-000000000000000000000000-not-a-real-key"},
    "conversations": [{
        "key": "C1", "table": "conversations", "workspaceId": "ws", "createdByUserId": "u_maya",
        "title": M1_TITLE, "titleSource": "auto", "agentRoleSlug": "organizer", "_createdAgo": "-3m",
        "messages": [
            {"key": "C1m1", "role": "user", "_at": "-3m", "parts": [{"type": "text", "text": M1_ASK}]},
            {"key": "C1m2", "role": "assistant", "_at": "-3m", "tier": "standard", "parts": [
                {"type": "step-start"},
                tool_part("call_demo_list", "manage_missions", {"action": "list", "workspace": "billing-web"}, "2 open, none touch /invoices"),
                tool_part("call_demo_recall", "recall", {"query": "invoices table phone layout"}, "1 pattern: tables stack as cards under 640px"),
                tool_part("call_demo_tasks", "list_tasks", {"workspace": "billing-web", "status": "in_progress"}, "nothing in flight on /invoices"),
                {"type": "text", "text": "Here's a draft with checks you can read."},
                {"type": "tool-manage_missions", "toolCallId": "call_demo_create", "state": "approval-requested", "input": M1_DRAFT, "approval": {"id": "demo-approval-m1"}},
            ]},
        ],
        "approval": {"messageKey": "C1m2", "toolCallId": "call_demo_create", "approvalId": "demo-approval-m1", "toolName": "manage_missions"},
        "_onConfirm": {
            "summary": f'filed "{M1_TITLE}"', "data": f"Mission created: {M1_TITLE}. The Organizer is planning it.",
            "objects": [{"kind": "mission", "id": "{{M1}}", "workspaceId": "{{ws}}", "title": M1_TITLE, "fallbackText": f"Mission: {M1_TITLE}"}],
            "followUp": "Filed. The Organizer is planning it now.",
        },
    }],
    "directives": [],
}

data = {
    "_meta": {"purpose": "Synthetic dataset for the buildd v7 film. All names, ids, repos, people and numbers are fictional.",
              "wallClockSeconds": TL[-1]["t"], "conventions": "see build-multi-currency.py"},
    "team": team, "users": users, "accounts": accounts, "runners": runners, "workspace": workspace, "roles": roles,
    "missions": [mission], "taskSchedules": [], "tasks": tasks, "workers": workers, "artifacts": artifacts,
    "missionNotes": mission_notes, "memories": [], "heartbeatPastTicks": [], "backgroundMissions": [], "chat": chat, "timeline": TL,
}
text = json.dumps(data, indent=2, ensure_ascii=False)
assert "checkout" not in text.lower(), "the v7 story must not say checkout"
with open(OUT, "w") as f:
    f.write(text)
print(OUT, "events:", len(TL), "end t:", TL[-1]["t"])
