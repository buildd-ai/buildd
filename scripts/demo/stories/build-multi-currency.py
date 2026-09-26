#!/usr/bin/env python3
"""Generates the multi-currency demo story (fully fictional): python3 build-multi-currency.py [out.json]

Default output: multi-currency.json next to this file. Edit here and re-run; never hand-edit the JSON."""
import json, os

import sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "multi-currency.json")

REPO_SLUG = "harborline/billing-web"
REPO_URL = f"https://github.com/{REPO_SLUG}"
def pr_url(n): return f"{REPO_URL}/pull/{n}"

# Fake-but-shaped short ids. The seed script generates real UUIDs; it should
# force the first 8 hex chars of each task UUID to these so branch names line up.
SHORT = {
    "T0": "a3f09c12", "T1": "5be71d40", "T2": "c80e2a9f", "T3": "1d4c7b63",
    "T4": "e9a25f08", "T5": "7f31c6d2", "T6": "40bd98e1", "T7": "b62f0a57",
    "T7a": "0c95e3b4", "T8": "d17a4c9e", "T9": "3e8b51f6", "T10": "9a06d7c3",
    "T11": "f24c8e1a", "T12": "6b5d2f90", "V1": "8c1e4a7d", "H1": "2f7a9b3c",
}
MISSION_SHORT = "4d2e8b17"

def slug(title):
    import re
    return re.sub(r"[^a-z0-9]+", "-", title.lower())[:30]

def branch(tkey, title):
    return f"buildd/{SHORT[tkey]}-{slug(title)}"

ACCOUNT_NAME = "harborline-fleet"
def worker_name(tkey): return f"{ACCOUNT_NAME}-{SHORT[tkey]}"

team = {
    "key": "team", "table": "teams",
    "name": "Harborline", "slug": "harborline", "timezone": "America/Chicago",
}

users = [
    {"key": "u_maya", "table": "users", "name": "Maya Okafor", "email": "maya@harborline.example",
     "_note": "fictional eng lead; the human who answers the question from her phone"},
]

accounts = [
    {"key": "acct_fleet", "table": "accounts", "type": "user", "level": "worker",
     "name": ACCOUNT_NAME, "authType": "oauth", "maxConcurrentWorkers": 8,
     "apiKey": "bld_demo_0000000000000000000000000000", "apiKeyPrefix": "bld_demo",
     "_note": "one account, four runner hosts; worker.name = `${account.name}-${taskId[0:8]}` (claim route)"},
]

runners = [  # worker_heartbeats rows; workers.runner is the free-text runner id sent on claim
    {"key": "atlas", "table": "worker_heartbeats", "runner": "atlas", "localUiUrl": "http://atlas.local:8766", "maxConcurrentWorkers": 2, "_display": "atlas · Mac Studio"},
    {"key": "birch", "table": "worker_heartbeats", "runner": "birch", "localUiUrl": "http://birch.local:8766", "maxConcurrentWorkers": 2, "_display": "birch · Linux box"},
    {"key": "cedar", "table": "worker_heartbeats", "runner": "cedar", "localUiUrl": "http://cedar.local:8766", "maxConcurrentWorkers": 2, "_display": "cedar · cloud VM"},
    {"key": "dune",  "table": "worker_heartbeats", "runner": "dune",  "localUiUrl": "http://dune.local:8766",  "maxConcurrentWorkers": 2, "_display": "dune · cloud VM"},
]

workspace = {
    "key": "ws", "table": "workspaces",
    "name": "billing-web", "repo": REPO_URL, "accessMode": "restricted", "dataClass": "standard",
    "maxConcurrentTasks": 3, "configStatus": "admin_confirmed",
    "projects": [
        {"name": "web", "path": "apps/web", "description": "Customer portal + admin (Next.js)", "color": "#D4724A"},
        {"name": "api", "path": "apps/api", "description": "Public Invoices API", "color": "#0EA5E9"},
        {"name": "money", "path": "packages/money", "description": "Money, FX, rounding", "color": "#D97706"},
    ],
    "gitConfig": {
        "defaultBranch": "main", "branchingStrategy": "trunk", "useBuildBranch": True,
        "branchStrategy": "direct", "commitStyle": "conventional",
        "requiresPR": True, "targetBranch": "main", "autoCreatePR": True, "useClaudeMd": True,
        "criteriaGrader": "runner",
    },
    "_github": {"table": "github_repos", "fullName": REPO_SLUG, "_note": "repo identity should come from githubRepoId FK, not the free-text repo column"},
}

ROLE_BODY = "# {name}\n\n(Seed with the stock body from apps/web/src/lib/default-roles.ts.)\n"
roles = [
    {"key": "organizer",  "slug": "organizer",  "name": "Organizer",  "color": "#6366F1", "model": "sonnet", "canDelegateTo": ["builder", "researcher", "writer", "analyst"], "description": "Plans missions into phased tasks and keeps them moving"},
    {"key": "builder",    "slug": "builder",    "name": "Builder",    "color": "#0C72CB", "model": "opus",   "canDelegateTo": ["researcher"], "description": "Writes code, opens PRs, fixes its own CI"},
    {"key": "researcher", "slug": "researcher", "name": "Researcher", "color": "#B24C9C", "model": "sonnet", "canDelegateTo": ["builder"], "allowedTools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent"], "description": "Reads, compares, reports — never edits"},
    {"key": "writer",     "slug": "writer",     "name": "Writer",     "color": "#0EA5E9", "model": "sonnet", "canDelegateTo": ["researcher"], "description": "Docs and customer-facing prose"},
    {"key": "analyst",    "slug": "analyst",    "name": "Analyst",    "color": "#A855F7", "model": "sonnet", "canDelegateTo": ["researcher", "writer"], "description": "Derives judgments from data"},
    {"key": "reviewer",   "slug": "reviewer",   "name": "Reviewer",   "color": "#6366f1", "model": "sonnet", "canDelegateTo": [], "description": "Reviews PRs against the task (used by background missions only)",
     "_note": "stock reviewer color equals organizer's (#6366f1). For video legibility consider #14B8A6 — cosmetic, demo-only."},
]
for r in roles:
    r.update({"table": "workspace_skills", "isRole": True, "enabled": True, "origin": "manual",
              "content": ROLE_BODY.format(name=r["name"]), "contentHash": "<sha256 of content>",
              "workspaceId": "ws"})
    r.setdefault("allowedTools", [])

# ---------------------------------------------------------------- hero mission
M1_TITLE = "Multi-currency invoices"
M1_GOAL = "Let customers see, pay, and get receipts for invoices in their own currency."
hero_mission = {
    "key": "M1", "table": "missions", "workspaceId": "ws", "createdByUserId": "u_maya",
    "title": M1_TITLE,
    "description": M1_GOAL,
    "status": "active", "_statusAtEnd": "completed",
    "priority": 5, "orchestrationMode": "auto", "maxConcurrentTasks": 6,
    "defaultOutputRequirement": "pr_required", "pacingMode": "eager",
    "mergePolicy": {"tier": "auto-threshold", "threshold": {"maxLines": 800}},
    "integrationBranchEnabled": False, "workingBranch": None,
    "autoVerify": True, "autoSurfaceAudit": False,
    "scheduleId": None,
    "_heartbeat": "none — created from the dashboard (UI-created missions run once, no heartbeat schedule)",
    "goalCriteria": [
        {"type": "all_prs_merged", "label": "every task PR merged"},
        {"type": "no_open_tasks", "label": "no open tasks"},
        {"type": "command", "command": "pnpm test --filter @harborline/money --filter web -- currency", "label": "currency suite green"},
        {"type": "artifact_exists", "key": "fx-rounding-decision", "label": "rounding policy recorded"},
    ],
    "goalCriteriaState": None,
    "_idShort": MISSION_SHORT,
}

def task(key, title, role, kind, phase, phase_label, deps, **kw):
    t = {
        "key": key, "table": "tasks", "workspaceId": "ws", "missionId": kw.pop("missionId", "M1"),
        "title": title, "description": kw.pop("description", ""),
        "status": "pending", "_statusAtEnd": kw.pop("statusAtEnd", "completed"),
        "priority": kw.pop("priority", 0), "mode": kw.pop("mode", "execution"),
        "roleSlug": role, "kind": kind, "complexity": kw.pop("complexity", "normal"),
        "missionPhaseIndex": phase, "missionPhaseLabel": phase_label,
        "dependsOn": deps,  # task keys; seed maps to UUIDs
        "outputRequirement": kw.pop("outputRequirement", "pr_required"),
        "creationSource": kw.pop("creationSource", "mcp"),
        "createdByWorkerId": kw.pop("createdByWorkerId", "w0"),
        "taskClass": kw.pop("taskClass", "work"),
        "backend": "claude",
        "project": kw.pop("project", None),
        "pathManifest": kw.pop("pathManifest", None),
        "_idShort": SHORT[key],
    }
    t.update(kw)
    return t

P1, P2, P3 = "Foundations", "Currency through the product", "Prove it"
hero_tasks = [
    task("T0", f"Mission: {M1_TITLE}", "organizer", "coordination", None, None, [],
         mode="planning", outputRequirement="none", creationSource="orchestrator", createdByWorkerId=None,
         taskClass="bookkeeping",
         description="Plan the mission into phased tasks with dependsOn edges and concrete pathManifests.",
         complexity="normal"),
    task("T1", "RESEARCH: FX rate providers — freshness, cost, and what breaks when they're down",
         "researcher", "research", 1, P1, [], outputRequirement="artifact_required",
         description="Compare three rate providers on update cadence, pricing model, and outage behaviour. Recommend one plus a fallback. No code."),
    task("T2", "feat(db): currency and fx_rate_snapshot on invoices and line items",
         "builder", "engineering", 1, P1, [], project="web",
         pathManifest=["packages/db/schema.ts", "packages/db/migrations/"],
         description="Additive migration: invoices.currency, invoices.fx_rate_snapshot, line_items.amount_presentment. Default to account base currency."),
    task("T3", "feat(fx): rates service with a 15-minute cache and stale-rate fallback",
         "builder", "engineering", 1, P1, [], project="money",
         pathManifest=["packages/money/src/fx/"],
         description="Fetch, cache, and serve rates. When the provider is down, serve the last good rate and flag it stale; never block checkout."),
    task("T4", "feat(settings): customers can pick a billing currency",
         "builder", "engineering", 1, P1, [], project="web",
         pathManifest=["apps/web/src/app/settings/billing/"],
         description="Currency picker on the billing settings page, persisted per customer."),
    task("T5", "refactor(money): one locale-aware formatMoney, replace ad-hoc toFixed(2)",
         "builder", "engineering", 1, P1, [], project="money", complexity="simple",
         pathManifest=["packages/money/src/format.ts", "apps/web/src/components/Amount.tsx"],
         description="Single Intl.NumberFormat-backed helper. Replace hand-rolled formatting across the portal."),
    task("T6", "feat(api): currency on the public Invoices API (additive, v2-safe)",
         "builder", "engineering", 2, P2, ["T2"], project="api",
         pathManifest=["apps/api/src/routes/invoices/"],
         description="Expose currency + presentment amounts. Additive fields only; existing clients unaffected."),
    task("T7", "feat(invoices): render invoices in the customer's currency with a base-currency footnote",
         "builder", "engineering", 2, P2, ["T2", "T5"], project="web",
         pathManifest=["apps/web/src/app/invoices/[id]/", "packages/pdf/src/invoice.tsx"],
         description="Web view and PDF. Footnote shows base amount and the rate used."),
    task("T8", "feat(checkout): pay in the presentment currency via Stripe",
         "builder", "engineering", 2, P2, ["T2", "T3"], project="web", complexity="complex",
         pathManifest=["apps/web/src/app/pay/", "packages/payments/src/stripe.ts"],
         description="Create PaymentIntents in the customer currency using the snapshotted rate."),
    task("T9", "feat(export): accounting CSV carries both currencies and the rate used",
         "builder", "engineering", 2, P2, ["T2"], project="web",
         pathManifest=["apps/web/src/lib/export/"],
         description="Add currency, presentment amount, base amount, fx_rate columns to the ledger export."),
    task("T10", "feat(email): receipts show the paid currency and rate",
         "builder", "engineering", 2, P2, ["T7"], project="web", complexity="simple",
         pathManifest=["packages/email/templates/receipt.tsx"],
         description="Receipt email mirrors the invoice footnote."),
    task("T11", "test(e2e): pay a EUR invoice end to end",
         "builder", "engineering", 3, P3, ["T7", "T8"], project="web",
         pathManifest=["tests/e2e/multi-currency.spec.ts"],
         description="Create EUR customer → invoice → pay with test card → receipt → export row."),
    task("T12", "docs: multi-currency billing guide for account admins",
         "writer", "writing", 3, P3, ["T7", "T8"], project="web",
         pathManifest=["docs/billing/multi-currency.md"],
         description="How to enable, what customers see, how rounding works, how exports reconcile."),
    # CI self-heal: created by the GitHub webhook (buildCIRetryTask), not by the organizer
    task("T7a", "[builder · after CI #1] feat(invoices): render invoices in the customer's currency with a base-currency footnote",
         "builder", "engineering", 2, P2, [], project="web", priority=7,
         taskClass="attempt", parentTaskId="T7", ciRetryPrNumber=416, ciRetryHeadSha="9e41c07",
         creationSource="mcp", createdByWorkerId=None,
         context={"ciRetryPrNumber": 416, "iteration": 1, "failureContext": {
             "job": "unit", "test": "packages/pdf/src/invoice.snapshot.test.tsx",
             "excerpt": "Expected \"1.234,50 €\" — received \"1,234.50 €\" (locale de-DE)"}},
         description="CI failed on PR #416. Fix on the same branch."),
    # Goal-criterion verification (mission-criteria-verify.ts): bookkeeping, observe-only
    task("V1", "Verify goal criterion: currency suite green", None, None, None, None, [],
         outputRequirement="none", taskClass="bookkeeping", creationSource="orchestrator", createdByWorkerId=None,
         priority=2, tier="budget",
         loopConfig={"exitCondition": {"type": "command", "command": "pnpm test --filter @harborline/money --filter web -- currency"}, "maxLoops": 1},
         description="Run the command and report. Do not change code."),
]
# the organizer leaves the verify task unclassified in the real code path too
for t in hero_tasks:
    if t["key"] == "V1":
        t["kind"] = "observation"; t["_kindNote"] = "real verify tasks set no kind; 'observation' is a demo choice for the glyph"

# Hand-written 2–4 word display labels (tasks.label, read via taskDisplayLabel).
LABELS = {
    "T0": "plan the mission", "T1": "FX providers", "T2": "currency columns", "T3": "rates service",
    "T4": "currency picker", "T5": "formatMoney", "T6": "currency on API", "T7": "render in currency",
    "T8": "Stripe in currency", "T9": "dual-currency CSV", "T10": "receipt currency", "T11": "pay a EUR invoice",
    "T12": "admin guide", "T7a": "fix PDF locale", "V1": "verify currency suite", "H1": "dependency sweep",
}
for t in hero_tasks:
    t["label"] = LABELS[t["key"]]

# ------------------------------------------------------------ PRs (workers carry them)
PRS = {  # task -> (prNumber, +added, -removed, files, commits)
    "T2": (411, 186, 4, 5, 2),
    "T5": (412, 142, 97, 14, 3),
    "T3": (413, 318, 0, 7, 4),
    "T4": (414, 211, 12, 6, 2),
    "T6": (415, 164, 8, 5, 2),
    "T7": (416, 402, 61, 11, 4),
    "T8": (418, 537, 44, 12, 6),
    "T9": (417, 229, 18, 5, 3),
    "T10": (419, 96, 21, 3, 1),
    "T11": (420, 274, 0, 2, 2),
    "T12": (421, 188, 0, 2, 1),
}

RUNNER_OF = {"T0": "atlas", "T1": "birch", "T2": "atlas", "T3": "cedar", "T4": "dune", "T5": "atlas",
             "T6": "birch", "T7": "cedar", "T8": "dune", "T9": "atlas", "T10": "birch",
             "T7a": "birch", "T11": "cedar", "T12": "dune", "V1": "cedar", "H1": "dune"}

def title_of(k):
    for t in hero_tasks + []:
        if t["key"] == k: return t["title"]
    return {"H1": "Mission: Keep dependencies current"}[k]

workers = []
def mk_worker(tk, wk, **kw):
    base_title = title_of("T7") if tk == "T7a" else title_of(tk)
    w = {"key": wk, "table": "workers", "taskId": tk, "workspaceId": "ws", "accountId": "acct_fleet",
         "name": worker_name(tk), "runner": RUNNER_OF[tk],
         # T7a pushes to T7's branch: CI-retry attempts continue the parent branch
         "branch": branch("T7", title_of("T7")) if tk == "T7a" else branch(tk, base_title),
         "status": "idle", "_statusAtEnd": "completed",
         "waitingFor": None, "currentAction": None, "milestones": [],
         "prUrl": None, "prNumber": None, "prLifecycleStatus": None, "mergedAt": None,
         "commitCount": 0, "filesChanged": 0, "linesAdded": 0, "linesRemoved": 0,
         "costUsd": "0", "inputTokens": 0, "outputTokens": 0, "turns": 0}
    if tk in PRS:
        n, a, r, f, c = PRS[tk]
        w["_final"] = {"prNumber": n, "prUrl": pr_url(n), "linesAdded": a, "linesRemoved": r,
                       "filesChanged": f, "commitCount": c, "prLifecycleStatus": "merged"}
    w.update(kw)
    return w

WK = {"T0": "w0", "T1": "w1", "T2": "w2", "T3": "w3", "T4": "w4", "T5": "w5", "T6": "w6", "T7": "w7",
      "T8": "w8", "T9": "w9", "T10": "w10", "T7a": "w7a", "T11": "w11", "T12": "w12", "V1": "wv1", "H1": "wh1"}
for tk, wk in WK.items():
    if tk == "H1": continue
    workers.append(mk_worker(tk, wk))
# T7a continues PR #416, adds one commit
for w in workers:
    if w["key"] == "w7a":
        w["_final"] = {"prNumber": 416, "prUrl": pr_url(416), "linesAdded": 23, "linesRemoved": 9,
                       "filesChanged": 2, "commitCount": 1, "prLifecycleStatus": "merged"}
    if w["key"] == "w7":
        w["_final"]["prLifecycleStatus"] = "ci_failed"
        w["_final"]["_note"] = "w7 ends completed with PR #416 ci_failed; mergedAt is stamped on w7 (PR owner) when #416 merges after w7a's fix"

# ------------------------------------------------------------------ artifacts
artifacts = [
    {"key": "a_fx_report", "table": "artifacts", "workerId": "w1", "workspaceId": "ws", "missionId": "M1",
     "type": "report", "key_": "fx-provider-comparison", "title": "FX rate providers compared",
     "content": "## Recommendation\nPrimary: Provider B (hourly mid-market, flat monthly). Fallback: central-bank daily reference rates.\n\n"
                "## Why\n- A updates every minute but bills per call; our read pattern is bursty around invoice runs.\n"
                "- B's hourly cadence is well inside a 15-minute cache + snapshot-at-issue design.\n"
                "- C had no documented behaviour during outages.\n\n"
                "## What breaks when rates are down\nNothing customer-facing if we snapshot the rate on the invoice at issue time. "
                "Checkout reads the snapshot, not a live rate.",
     "visibility": "private", "metadata": {"sources": 9}},
    {"key": "a_rounding", "table": "artifacts", "workerId": "w8", "workspaceId": "ws", "missionId": "M1",
     "type": "content", "key_": "fx-rounding-decision", "title": "Decision: round converted amounts per line",
     "content": "Converted invoices round **each line** to the customer currency's minor unit. The total is the sum of rounded lines, "
                "so it always equals what Stripe charges. The ledger export carries a `rounding_delta` column so finance can reconcile to base currency.\n\n"
                "_Decided by Maya Okafor via the mission feed._",
     "visibility": "private", "metadata": {"decidedBy": "u_maya", "source": "waiting_input"}},
    {"key": "a_e2e_video", "table": "artifacts", "workerId": "w11", "workspaceId": "ws", "missionId": "M1",
     "type": "recording", "key_": None, "title": "E2E: EUR invoice paid end to end", "content": None,
     "storageKey": "demo/e2e-eur-invoice.webm", "visibility": "private", "metadata": {"durationSec": 38}},
    {"key": "a_summary", "table": "artifacts", "workerId": None, "workspaceId": "ws", "missionId": "M1",
     "type": "summary", "key_": "mission-summary", "title": "Multi-currency invoices — shipped",
     "content": "Customers can pick a billing currency, see invoices and receipts in it, and pay in it. "
                "Rates are snapshotted at issue; checkout never waits on the rate provider. Line-level rounding matches the card charge; "
                "the export reconciles to base currency.\n\n11 PRs merged · 1 CI failure fixed automatically · 1 decision from a human.",
     "visibility": "private", "metadata": {}},
]
for a in artifacts:
    a["key"], a["artifactKey"] = a.pop("key"), a.pop("key_")
    a["_column_note"] = "artifactKey -> artifacts.key (unique per workspace). 'key' here is the dataset ref."

# ------------------------------------------------------------------ mission notes
mission_notes = [
    {"key": "n_plan", "table": "mission_notes", "missionId": "M1", "taskId": "T0", "workerId": "w0",
     "authorType": "agent", "type": "decision", "title": "Plan: 3 phases, 12 tasks",
     "body": "**Foundations** (5, parallel): schema, FX service, currency picker, formatMoney, provider research.\n"
             "**Currency through the product** (5): API, invoice render, checkout, export, receipts.\n"
             "**Prove it** (2): EUR end-to-end test, admin guide.\n\nRates are snapshotted at invoice issue so checkout never waits on a live rate.",
     "actorLabel": "Organizer", "status": "open"},
    {"key": "n_q", "table": "mission_notes", "missionId": "M1", "taskId": "T8", "workerId": "w8",
     "authorType": "agent", "type": "question", "title": "Round per line, or only the total?",
     "body": "Converting a multi-line invoice, rounding each line to cents can differ from rounding the total by up to one minor unit per line. "
             "Per line: the total equals exactly what Stripe charges the card. "
             "Total only: matches the base-currency ledger, but the card charge can be off by a cent or two. "
             "Which should be the source of truth?",
     "defaultChoice": "Per line — match Stripe", "actorLabel": "Builder", "status": "open", "_statusAtEnd": "answered"},
    {"key": "n_reply", "table": "mission_notes", "missionId": "M1", "taskId": "T8", "workerId": "w8",
     "authorType": "user", "type": "reply", "replyTo": "n_q", "title": "Per line",
     "body": "Per line. The card charge is what customers see. Put the delta in the export so finance can reconcile.",
     "actorLabel": "Maya Okafor", "status": "open"},
    {"key": "n_ci", "table": "mission_notes", "missionId": "M1", "taskId": "T7a", "workerId": None,
     "authorType": "system", "type": "update", "title": "CI failed on #416 — fix dispatched",
     "body": "Invoice PDF snapshot: de-DE rendered `1,234.50 €`, expected `1.234,50 €`. A builder picked it up on the same branch.",
     "actorLabel": "buildd", "status": "open"},
    {"key": "n_done", "table": "mission_notes", "missionId": "M1", "taskId": None, "workerId": None,
     "authorType": "system", "type": "update", "title": "All 4 goal criteria pass — mission complete",
     "body": None, "actorLabel": "buildd", "status": "open"},
]

# ------------------------------------------------------------------ memories (learn)
memories = [
    {"key": "mem1", "table": "memories", "teamId": "team", "type": "decision", "project": "money",
     "title": "Converted amounts round per line, never on the total",
     "content": "Line-level rounding keeps the invoice total equal to the card charge. Reconcile to base currency via export.rounding_delta.",
     "tags": ["fx", "rounding", "stripe"], "files": ["packages/money/src/fx/convert.ts"], "source": "task:T8"},
    {"key": "mem2", "table": "memories", "teamId": "team", "type": "gotcha", "project": "pdf",
     "title": "Invoice PDF snapshots are locale-sensitive",
     "content": "Snapshot tests run under several locales. Format through formatMoney(amount, currency, locale) — never toLocaleString() with the process default.",
     "tags": ["pdf", "i18n", "ci"], "files": ["packages/pdf/src/invoice.snapshot.test.tsx"], "source": "task:T7a"},
    {"key": "mem3", "table": "memories", "teamId": "team", "type": "pattern", "project": "money",
     "title": "Snapshot the FX rate at invoice issue",
     "content": "Store fx_rate_snapshot on the invoice. Anything downstream (checkout, receipt, export) reads the snapshot so a provider outage can't change what a customer owes.",
     "tags": ["fx", "architecture"], "files": ["packages/db/schema.ts"], "source": "task:T1"},
    {"key": "mem4", "table": "memories", "teamId": "team", "type": "architecture", "project": "web",
     "title": "Dark mode tokens live in one CSS layer",
     "content": "All color tokens come from styles/tokens.css; components never hardcode hex. Portal and admin share the layer.",
     "tags": ["ui", "theming"], "files": ["apps/web/src/styles/tokens.css"], "source": "mission:B1"},
    {"key": "mem5", "table": "memories", "teamId": "team", "type": "discovery", "project": "pdf",
     "title": "PDF render time was dominated by font loading",
     "content": "Embedding a subset font and reusing one renderer instance per worker process removed most of the per-invoice cost.",
     "tags": ["pdf", "performance"], "files": ["packages/pdf/src/renderer.ts"], "source": "mission:B2"},
]

# ------------------------------------------------------------------ heartbeat mission
heartbeat = {
    "mission": {"key": "M2", "table": "missions", "workspaceId": "ws", "title": "Keep dependencies current",
                "description": "Every 6 hours: review open dependency PRs, merge the safe ones when CI is green, file a task for anything that needs code changes.",
                "status": "active", "orchestrationMode": "auto", "priority": 1,
                "defaultOutputRequirement": "auto", "scheduleId": "S2",
                "goalCriteria": None, "_createdAgo": "-12d"},
    "schedule": {"key": "S2", "table": "task_schedules", "workspaceId": "ws",
                 "name": "Mission: Keep dependencies current", "cronExpression": "0 */6 * * *", "timezone": "America/Chicago",
                 "enabled": True, "maxConcurrentFromSchedule": 1,
                 "taskTemplate": {"title": "Mission: Keep dependencies current", "mode": "planning",
                                  "context": {"missionId": "M2", "heartbeat": True,
                                              "heartbeatChecklist": "- [ ] Any open dependency PRs with green CI? Merge patch/minor.\n- [ ] Any major bumps? File a builder task with the changelog link.\n- [ ] Nothing changed since last tick? Report OK and stop."}},
                 "totalRuns": 47, "consecutiveFailures": 0,
                 "_lastRunAt": "fires at t=1260 during the demo", "_nextRunAt": "t=1260 + 6h",
                 "_note": "totalRuns is fictional"},
    "tick_task": task("H1", "Mission: Keep dependencies current", "organizer", "coordination", None, None, [],
                      missionId="M2", mode="planning", outputRequirement="none", creationSource="schedule",
                      createdByWorkerId=None, scheduleId="S2", heartbeatTickAnchor="<ISO of tick>",
                      description="Heartbeat tick.", label=LABELS["H1"]),
    "tick_worker": mk_worker("H1", "wh1"),
    "past_ticks": [
        {"agoHours": 6, "summary": "Merged 2 patch bumps (CI green). No majors."},
        {"agoHours": 12, "summary": "OK — nothing new."},
        {"agoHours": 18, "summary": "Filed builder task: date library major bump needs a codemod."},
    ],
}

# ------------------------------------------------------------------ background missions
def bg_task(mkey, idx, title, role, kind, pr=None, status="completed", **kw):
    planning = title.startswith("Mission: ")  # the organizer's planning run: bookkeeping, like T0
    return {"key": f"{mkey}_t{idx}", "table": "tasks", "workspaceId": "ws", "missionId": mkey,
            "title": title, "label": kw["label"], **({"mode": "planning"} if planning else {}), "roleSlug": role, "kind": kind, "status": status,
            "taskClass": kw.get("taskClass", "bookkeeping" if planning else "work"),
            "outputRequirement": "pr_required" if pr else ("none" if planning else "artifact_required"),
            "_worker": {"runner": kw.get("runner", "atlas"), "status": "completed" if status == "completed" else "error",
                        **({"prNumber": pr[0], "prUrl": pr_url(pr[0]), "linesAdded": pr[1], "linesRemoved": pr[2],
                            "prLifecycleStatus": "merged"} if pr else {})}}

background = [
    {"mission": {"key": "B1", "table": "missions", "workspaceId": "ws", "title": "Dark mode for the customer portal",
                 "description": "Portal and PDFs respect the customer's theme preference.", "status": "completed",
                 "_createdAgo": "-4d", "_completedAgo": "-3d",
                 "goalCriteria": [{"type": "all_prs_merged"}, {"type": "no_open_tasks"}],
                 "goalCriteriaState": {"overall": "pass"}},
     "tasks": [
         bg_task("B1", 0, "Mission: Dark mode for the customer portal", "organizer", "coordination", label="plan the mission"),
         bg_task("B1", 1, "refactor(ui): move every color to design tokens", "builder", "engineering", (388, 612, 540), runner="cedar", label="design tokens"),
         bg_task("B1", 2, "feat(ui): theme toggle with system default", "builder", "engineering", (389, 144, 12), runner="atlas", label="theme toggle"),
         bg_task("B1", 3, "fix(pdf): invoices stay light regardless of theme", "builder", "engineering", (390, 38, 6), runner="dune", label="light PDFs"),
         bg_task("B1", 4, "[builder · after CI #1] feat(ui): theme toggle with system default", "builder", "engineering", None, taskClass="attempt", runner="birch", label="fix theme toggle"),
         bg_task("B1", 5, "docs: theming for embedded portal hosts", "writer", "writing", (392, 71, 0), runner="birch", label="theming docs"),
     ]},
    {"mission": {"key": "B2", "table": "missions", "workspaceId": "ws", "title": "Cut invoice PDF render time in half",
                 "description": "Month-end invoice runs shouldn't queue.", "status": "completed",
                 "_createdAgo": "-7d", "_completedAgo": "-6d",
                 "goalCriteria": [{"type": "command", "command": "pnpm bench:pdf --assert-p50-under 400", "label": "p50 under 400ms"}, {"type": "all_prs_merged"}],
                 "goalCriteriaState": {"overall": "pass"}},
     "tasks": [
         bg_task("B2", 0, "Mission: Cut invoice PDF render time in half", "organizer", "coordination", label="plan the mission"),
         bg_task("B2", 1, "RESEARCH: where PDF render time goes (profile a month-end run)", "researcher", "research", runner="birch", label="profile PDF render"),
         bg_task("B2", 2, "perf(pdf): subset-embed fonts, reuse one renderer per process", "builder", "engineering", (371, 206, 88), runner="atlas", label="subset fonts"),
         bg_task("B2", 3, "perf(pdf): stream pages instead of buffering the whole document", "builder", "engineering", (372, 163, 71), runner="cedar", label="stream PDF pages"),
         bg_task("B2", 4, "test(bench): p50/p95 PDF render benchmark in CI", "builder", "engineering", (374, 118, 0), runner="dune", label="render benchmark"),
     ]},
    {"mission": {"key": "B3", "table": "missions", "workspaceId": "ws", "title": "Audit log for every admin action",
                 "description": "Every admin mutation is recorded, searchable, and exportable.", "status": "completed",
                 "_createdAgo": "-11d", "_completedAgo": "-10d",
                 "goalCriteria": [{"type": "all_prs_merged"}, {"type": "artifact_exists", "key": "audit-coverage-report"}],
                 "goalCriteriaState": {"overall": "pass"}},
     "tasks": [
         bg_task("B3", 0, "Mission: Audit log for every admin action", "organizer", "coordination", label="plan the mission"),
         bg_task("B3", 1, "ANALYSIS: which admin routes mutate state today", "analyst", "analysis", runner="birch", label="mutating admin routes"),
         bg_task("B3", 2, "feat(db): audit_events table with actor, target, diff", "builder", "engineering", (351, 142, 0), runner="atlas", label="audit events table"),
         bg_task("B3", 3, "feat(api): record an audit event from every admin mutation", "builder", "engineering", (353, 489, 77), runner="cedar", label="audit every mutation"),
         bg_task("B3", 4, "feat(admin): searchable audit log page with CSV export", "builder", "engineering", (354, 377, 15), runner="dune", label="audit log page"),
         bg_task("B3", 5, "fix(api): bulk-refund route skipped the audit hook", "builder", "engineering", (356, 29, 3), runner="atlas", label="bulk-refund audit"),
         bg_task("B3", 6, "[reviewer] PR #353: feat(api): record an audit event from every admin mutation", "reviewer", "engineering", None, runner="birch", label="review audit PR"),
     ]},
    {"mission": {"key": "B4", "table": "missions", "workspaceId": "ws", "title": "Usage-based pricing — spec first",
                 "description": "Write the spec and pricing-page copy before any code.", "status": "paused",
                 "isHeld": False, "_createdAgo": "-1d",
                 "_note": "one non-completed row so the list isn't uniformly green"},
     "tasks": [
         bg_task("B4", 0, "SPEC: metering, invoicing, and proration for usage-based plans", "writer", "writing", None, status="pending", label="usage pricing spec"),
     ]},
]

# ------------------------------------------------------------------ timeline
TL = []
def ev(t, op, **kw): TL.append({"t": t, "op": op, **kw})

def claim(t, tk):
    ev(t, "claim", task=tk, worker=WK[tk], runner=RUNNER_OF[tk],
       api="POST /api/workers/claim {runner, workspaceId, availableSkills}",
       db="tasks.status=assigned,claimedBy,claimedAt; INSERT workers(status=idle, name, runner, branch)")
    ev(t + 3, "worker_status", worker=WK[tk], status="running", api=f"PATCH /api/workers/{WK[tk]} {{status:'running'}}",
       db="workers.status=running, startedAt; tasks.status=in_progress")

def prog(t, tk, pct, msg, **kw):
    ev(t, "progress", worker=WK[tk], pct=pct, message=msg,
       api="MCP buildd update_progress {progress, message} → PATCH /api/workers/:id {appendMilestones, currentAction}",
       db="workers.currentAction=message; workers.milestones += {type:'status', label, progress, ts}", **kw)

def open_pr(t, tk, n=None):
    pn = n or PRS[tk][0]
    _, a, r, f, c = PRS[tk]
    ev(t, "pr_open", worker=WK[tk], prNumber=pn, prUrl=pr_url(pn), title=title_of(tk),
       linesAdded=a, linesRemoved=r, filesChanged=f, commitCount=c,
       api="MCP buildd create_pr {title, head, lede}",
       db="workers.prUrl, prNumber, prLifecycleStatus=pr_open, linesAdded/Removed, filesChanged, commitCount")

def complete(t, tk, summary):
    ev(t, "complete", task=tk, worker=WK[tk], summary=summary,
       api="MCP buildd complete_task {summary}",
       db="workers.status=completed, completedAt; tasks.status=completed, tasks.result={summary, prUrl, prNumber, ...}; unblocks dependents")

def ci(t, tk, state, pn=None):
    pn = pn or PRS[tk][0]
    ev(t, "ci", worker=WK[tk], prNumber=pn, state=state,
       api="GitHub webhook check_suite → POST /api/github/webhook",
       db=f"workers.prLifecycleStatus={state}")

def merge(t, tk, pn=None):
    pn = pn or PRS[tk][0]
    ev(t, "merge", worker=WK[tk], prNumber=pn,
       api="auto-merge on CI green (mergePolicy.tier=auto-threshold) → GitHub pull_request closed+merged webhook",
       db="workers.mergedAt=now, prLifecycleStatus=merged")

ev(0, "mission_create", mission="M1", title=M1_TITLE, description=M1_GOAL,
   api="POST /api/missions {title, description, workspaceId, goalCriteria, maxConcurrentTasks:6}",
   db="INSERT missions", beat="The one-sentence goal")
ev(2, "task_create", task="T0", api="(mission create auto-starts the organizer)", db="INSERT tasks (mode=planning, roleSlug=organizer)")
claim(5, "T0")
prog(8, "T0", 10, "Reading the repo: apps/web, apps/api, packages/money")
prog(20, "T0", 35, "Found money formatted by hand in many places — one helper first, then everything else")
prog(31, "T0", 60, "Snapshot rates at invoice issue so checkout never waits on a live rate")
prog(40, "T0", 85, "Drafting plan: 3 phases, 12 tasks, dependencies from path manifests")
for i, k in enumerate(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"]):
    ev(44 + i, "task_create", task=k, api="MCP buildd create_task {title, description, roleSlug, kind, dependsOn, pathManifest, missionId}",
       db="INSERT tasks (status=pending)", beat="Fan-out" if i == 0 else None)
ev(56, "mission_note", note="n_plan", api="MCP buildd post_note {type:'decision'}", db="INSERT mission_notes")
complete(58, "T0", "Planned 12 tasks in 3 phases. Five can start now.")

# Phase 1 — five at once
for i, k in enumerate(["T1", "T2", "T3", "T4", "T5"]):
    claim(59 + i, k)  # runners are nudged the moment the plan lands; all five running by 1:06
TL[-2]["beat"] = "Five agents, four machines, same minute"
prog(140, "T1", 15, "Reading three providers' docs and status-page history", )
prog(150, "T2", 20, "Writing migration: invoices.currency, fx_rate_snapshot")
prog(158, "T3", 15, "Sketching cache: 15-min TTL, last-good-rate fallback")
prog(165, "T4", 20, "Adding currency picker to billing settings")
prog(170, "T5", 25, "Replacing toFixed(2) with formatMoney across the portal")
prog(230, "T2", 55, "Migration applies cleanly on a fresh database and on a copy with existing invoices")
prog(260, "T5", 60, "Amount component now takes currency + locale")
prog(290, "T3", 40, "Provider client with retries and a circuit breaker")
prog(320, "T4", 45, "Persisting preference; defaulting to account base currency")
prog(340, "T1", 45, "Provider C has no documented outage behaviour — ruling it out")
prog(380, "T2", 85, "Tests pass; backfill defaults verified")
open_pr(420, "T2")
complete(430, "T2", "Additive migration for currency and rate snapshot; defaults backfilled.")
claim(436, "T6"); claim(440, "T9")
prog(450, "T5", 90, "Snapshot tests updated for the new helper")
open_pr(480, "T5")
complete(490, "T5", "One formatMoney helper; ad-hoc formatting removed.")
claim(496, "T7")
TL[-2]["beat"] = "Phase 2 starts before phase 1 finishes"
ci(500, "T2", "ci_running"); ci(520, "T2", "ci_green"); merge(545, "T2")
prog(510, "T6", 30, "Adding currency + presentment fields to the Invoices API, additive only")
prog(530, "T9", 25, "Export: adding currency and fx_rate columns")
prog(560, "T3", 70, "Stale-rate path: serves last good rate and flags it; checkout never blocks")
prog(575, "T7", 20, "Invoice page reads presentment amounts")
ci(505, "T5", "ci_running"); ci(580, "T5", "ci_green"); merge(600, "T5")
prog(620, "T4", 70, "Settings page e2e-tested in three locales")
prog(640, "T1", 75, "Writing recommendation")
prog(660, "T6", 65, "OpenAPI schema updated; old clients unaffected")
open_pr(690, "T3")
complete(700, "T3", "Rates service with 15-min cache and stale-rate fallback.")
claim(706, "T8")
TL[-2]["beat"] = "Six agents running at once (mission cap)"
prog(720, "T7", 45, "PDF footnote: base amount and the rate used")
prog(735, "T9", 50, "Reconciling presentment vs base in the export")
ci(700, "T3", "ci_running"); ci(790, "T3", "ci_green"); merge(815, "T3")
prog(760, "T8", 20, "Creating PaymentIntents in the customer currency from the snapshotted rate")
open_pr(800, "T6"); complete(820, "T6", "Invoices API exposes currency and presentment amounts, additively.")
prog(840, "T8", 40, "Line items convert cleanly — but rounding per line vs total gives different card charges")
ev(868, "waiting_input", worker="w8", task="T8", note="n_q",
   waitingFor={"type": "question", "prompt": "Round converted amounts per line (matches the Stripe charge) or only on the total (matches the base ledger)?",
               "options": ["Per line — match Stripe", "Total only — match the ledger"]},
   api="PATCH /api/workers/w8 {status:'waiting_input', waitingFor} + MCP post_note {type:'question'}",
   db="workers.status=waiting_input, waitingFor; INSERT mission_notes(type=question); push notification 'Agent needs your input'",
   beat="One agent asks a sharp question")
open_pr(880, "T4"); complete(890, "T4", "Customers can choose a billing currency.")
ev(905, "artifact", artifact="a_fx_report", worker="w1", api="MCP buildd create_artifact {type:'report', key:'fx-provider-comparison'}", db="INSERT artifacts")
complete(915, "T1", "Recommend Provider B with central-bank fallback; snapshot at issue makes outages harmless.")
ci(830, "T6", "ci_running"); ci(905, "T6", "ci_green"); merge(930, "T6")
ci(895, "T4", "ci_running"); ci(975, "T4", "ci_green"); merge(995, "T4")
prog(940, "T7", 80, "Web view and PDF in customer currency")
prog(960, "T9", 70, "Export columns: currency, presentment_amount, base_amount, fx_rate")
open_pr(990, "T7"); complete(1005, "T7", "Invoices render in customer currency with a base-currency footnote.")
claim(1010, "T10")
ev(1014, "human_reply", worker="w8", task="T8", note="n_reply", from_="u_maya", channel="phone",
   message="Per line. The card charge is what customers see. Put the delta in the export so finance can reconcile.",
   api="POST /api/workers/w8/respond {message}  (+ mission_notes reply)",
   db="INSERT mission_notes(type=reply, replyTo=n_q); n_q.status=answered; worker resumes",
   beat="Human answers from her phone — 2m 26s after the question")
ev(1018, "worker_status", worker="w8", status="running", api="PATCH /api/workers/w8 {status:'running'}", db="workers.status=running, waitingFor=null")
ev(1024, "artifact", artifact="a_rounding", worker="w8", api="MCP buildd create_artifact {key:'fx-rounding-decision'}", db="INSERT artifacts")
ev(1028, "memory", memory="mem1", api="MCP learn {type:'decision', title, content}", db="INSERT memories")
ev(1032, "agent_message", fromWorker="w8", toTask="T9", toWorker="w9",
   message="Rounding is per line (see fx-rounding-decision). Please add a rounding_delta column to the export.",
   api="agent-to-agent message (delivered on w9's next update_progress)", db="workers.pendingInstructions / instructionHistory on w9",
   beat="Agents coordinate with each other")
prog(1040, "T9", 80, "Added rounding_delta column per the rounding decision")
prog(1050, "T8", 60, "Per-line rounding in convert(); totals now equal the charge")
prog(1070, "T10", 40, "Receipt template mirrors the invoice footnote")
ci(1010, "T7", "ci_running")
ev(1108, "ci", worker="w7", prNumber=416, state="ci_failed",
   failure={"job": "unit", "test": "packages/pdf/src/invoice.snapshot.test.tsx", "excerpt": "Expected \"1.234,50 €\" — received \"1,234.50 €\" (locale de-DE)"},
   api="GitHub webhook check_suite(failure) → POST /api/github/webhook", db="workers.prLifecycleStatus=ci_failed, prCheckFailureCount=1",
   beat="CI goes red")
ev(1110, "task_create", task="T7a", api="webhook → buildCIRetryTask()", db="INSERT tasks(taskClass=attempt, parentTaskId=T7, ciRetryPrNumber=416, priority=7)")
ev(1111, "mission_note", note="n_ci", api="(system)", db="INSERT mission_notes")
claim(1116, "T7a")
prog(1130, "T7a", 20, "Reading CI log: de-DE snapshot uses the process locale")
open_pr(1150, "T9"); complete(1160, "T9", "Ledger export carries both currencies, the rate, and a rounding delta.")
prog(1180, "T7a", 60, "PDF footnote was calling toLocaleString() — routed it through formatMoney(locale)")
prog(1200, "T8", 80, "Stripe test mode: EUR, GBP, JPY (zero-decimal) all charge the invoice total exactly")
ev(1215, "memory", memory="mem2", api="MCP learn {type:'gotcha'}", db="INSERT memories")
ev(1222, "push_commit", worker="w7a", prNumber=416, sha="c3d8e21", api="git push (same branch)", db="workers.lastCommitSha, commitCount")
ci(1225, "T7", "ci_running", 416)
ci(1165, "T9", "ci_running"); ci(1245, "T9", "ci_green"); merge(1270, "T9")
# heartbeat tick of the second mission, mid-demo
ev(1260, "schedule_fire", schedule="S2", task="H1", api="cron → /api/cron/schedules", db="INSERT tasks(H1, creationSource=schedule); task_schedules.lastRunAt, totalRuns+1",
   beat="Meanwhile, the recurring mission ticks")
ev(1263, "claim", task="H1", worker="wh1", runner="dune", api="POST /api/workers/claim", db="INSERT workers")
ev(1266, "worker_status", worker="wh1", status="running", api="PATCH /api/workers/wh1", db="workers.status=running")
ev(1300, "progress", worker="wh1", pct=60, message="Two patch bumps with green CI — merging", api="update_progress", db="workers.milestones")
ev(1330, "complete", task="H1", worker="wh1", summary="Merged 2 patch bumps. No majors pending. Next tick in 6h.", api="complete_task", db="tasks.status=completed")
ev(1300, "ci", worker="w7", prNumber=416, state="ci_green", api="GitHub webhook (check_suite on the PR owner row)", db="workers(w7).prLifecycleStatus=ci_green", beat="CI heals itself")
complete(1310, "T7a", "Fixed locale-sensitive PDF footnote; CI green on #416.")
merge(1330, "T7", 416)
open_pr(1340, "T8"); complete(1352, "T8", "Checkout charges in the customer's currency; per-line rounding matches Stripe exactly.")
claim(1358, "T11"); claim(1362, "T12")
TL[-2]["beat"] = "Phase 3: prove it"
prog(1380, "T10", 85, "Receipt preview in EUR and JPY")
ci(1355, "T8", "ci_running"); ci(1450, "T8", "ci_green"); merge(1475, "T8")
open_pr(1420, "T10"); complete(1430, "T10", "Receipts show paid currency and the rate used.")
prog(1440, "T11", 25, "Seeding a EUR customer and invoice")
prog(1470, "T12", 35, "Drafting: enabling currencies, what customers see")
ci(1435, "T10", "ci_running"); ci(1520, "T10", "ci_green"); merge(1545, "T10")
prog(1560, "T11", 55, "Paying with a test card in EUR; asserting receipt and export row")
prog(1600, "T12", 70, "Rounding section links the recorded decision")
open_pr(1690, "T12"); complete(1700, "T12", "Admin guide for multi-currency billing.")
prog(1720, "T11", 85, "Green three runs in a row; recording the run")
ci(1705, "T12", "ci_running"); ci(1770, "T12", "ci_green"); merge(1790, "T12")
ev(1850, "artifact", artifact="a_e2e_video", worker="w11", api="MCP buildd upload_artifact {type:'recording'}", db="INSERT artifacts")
open_pr(1870, "T11"); complete(1885, "T11", "EUR invoice paid end to end: invoice → card → receipt → export.")
ci(1890, "T11", "ci_running"); ci(2010, "T11", "ci_green"); merge(2035, "T11")
TL[-1]["beat"] = "Last PR lands"
# goal criteria
ev(2040, "criteria_eval", mission="M1",
   state={"overall": "PENDING", "criteria": [
       {"index": 0, "type": "all_prs_merged", "label": "every task PR merged", "verdict": "pass", "evidence": "11 task PRs merged into main"},
       {"index": 1, "type": "no_open_tasks", "label": "no open tasks", "verdict": "pass", "evidence": "All deliverable tasks closed"},
       {"index": 2, "type": "command", "label": "currency suite green", "verdict": "PENDING", "evidence": "verifying on runner…", "workerTaskId": "V1"},
       {"index": 3, "type": "artifact_exists", "label": "rounding policy recorded", "verdict": "pass", "evidence": "artifact fx-rounding-decision"}]},
   api="mission evaluate (auto on last task close) → missions.goalCriteriaState", db="UPDATE missions.goalCriteriaState; INSERT tasks(V1, taskClass=bookkeeping)",
   beat="Goal criteria go green one by one")
claim(2046, "V1")
prog(2080, "V1", 50, "Running: pnpm test --filter @harborline/money --filter web -- currency")
complete(2200, "V1", "Command exited 0.")
ev(2205, "criteria_eval", mission="M1",
   state={"overall": "pass", "criteria": [
       {"index": 0, "verdict": "pass"}, {"index": 1, "verdict": "pass"},
       {"index": 2, "verdict": "pass", "evidence": "Command exited with code 0"}, {"index": 3, "verdict": "pass"}]},
   api="verification task result → missions.goalCriteriaState", db="UPDATE missions.goalCriteriaState.overall=pass")
ev(2212, "artifact", artifact="a_summary", api="mission completion", db="INSERT artifacts(key=mission-summary)")
ev(2215, "mission_note", note="n_done", api="(system)", db="INSERT mission_notes")
ev(2220, "mission_complete", mission="M1", api="canCompleteMission → missions.status=completed", db="missions.status=completed, completedAt",
   beat="Mission complete — 37 minutes")

# ------------------------------------------------------------------ tool calls
# Runner-shaped structured tool events (the `tool` op in advance.ts → an action
# milestone {tool, path, add, rem, cmd}), so task pages have a tape and a
# Touched list. Seeded RNG: same output every run.
import random
rnd = random.Random(7)

def tool(worker, t, tool, path=None, add=None, rem=None, cmd=None):
    e = {'t': t, 'op': 'tool', 'worker': worker, 'tool': tool}
    if path: e['path'] = path
    if cmd: e['cmd'] = cmd
    if add is not None: e['add'] = add
    if rem is not None: e['rem'] = rem
    TL.append(e)

# T7 (w7): invoice render. running 499..1005
reads7 = ['packages/money/src/formatMoney.ts', 'apps/web/src/app/invoices/[id]/page.tsx', 'packages/pdf/src/invoice.tsx',
          'packages/money/src/fx/convert.ts', 'packages/db/src/schema/invoices.ts', 'packages/pdf/src/layout.tsx',
          'apps/web/src/app/invoices/[id]/LineItems.tsx']
t = 501
while t < 690:
    tool('w7', t, 'Read', rnd.choice(reads7)); t += rnd.randint(5, 13)
for t, a, r in [(572, 9, 3), (590, 14, 4), (628, 12, 2), (660, 13, 3)]:
    tool('w7', t, 'Edit', 'apps/web/src/app/invoices/[id]/page.tsx', a, r)
tool('w7', 696, 'Bash', cmd='pnpm --filter @harborline/money test format')
for t, a, r in [(718, 11, 2), (726, 9, 2), (733, 11, 2)]:
    tool('w7', t, 'Edit', 'packages/pdf/src/invoice.tsx', a, r)
tool('w7', 741, 'Write', 'packages/pdf/src/BaseCurrencyFootnote.tsx', 30, 0)
for t, a in [(744, 3), (747, 2), (750, 2), (753, 3), (756, 1), (758, 1)]:
    tool('w7', t, 'Edit', 'packages/pdf/src/BaseCurrencyFootnote.tsx', a, 0)
tool('w7', 745, 'Read', 'packages/money/src/formatMoney.ts')
for t in range(800, 985, 9):
    tool('w7', t, rnd.choice(['Edit', 'Read', 'Read']), rnd.choice(reads7 + ['packages/pdf/src/BaseCurrencyFootnote.tsx']), rnd.randint(2, 12), rnd.randint(0, 4))
tool('w7', 960, 'Bash', cmd='pnpm --filter @harborline/pdf test')

# T8 (w8): checkout. running 709..868 (then waits), resumes 1018..1352
reads8 = ['packages/payments/src/stripe.ts', 'apps/web/src/app/pay/[invoiceId]/page.tsx', 'packages/money/src/fx/convert.ts',
          'packages/money/src/fx/snapshot.ts', 'packages/payments/src/intents.ts']
t = 711
while t < 800:
    tool('w8', t, 'Read', rnd.choice(reads8)); t += rnd.randint(4, 11)
for t, a, r in [(802, 18, 4), (815, 14, 2)]:
    tool('w8', t, 'Edit', 'packages/payments/src/stripe.ts', a, r)
for t, a, r in [(826, 21, 2), (838, 11, 1)]:
    tool('w8', t, 'Edit', 'apps/web/src/app/pay/[invoiceId]/page.tsx', a, r)
tool('w8', 850, 'Bash', cmd='pnpm --filter @harborline/payments test convert')
tool('w8', 858, 'Read', 'packages/money/src/fx/convert.ts')

# T7a (w7a): CI fix. running 1119..1310
for t, p in [(1121, 'packages/pdf/src/invoice.snapshot.test.tsx'), (1127, 'packages/pdf/src/BaseCurrencyFootnote.tsx'),
             (1134, 'packages/money/src/formatMoney.ts'), (1150, 'packages/pdf/src/BaseCurrencyFootnote.tsx')]:
    tool('w7a', t, 'Read', p)
tool('w7a', 1170, 'Edit', 'packages/pdf/src/BaseCurrencyFootnote.tsx', 14, 7)
tool('w7a', 1176, 'Edit', 'packages/pdf/src/invoice.snapshot.test.tsx', 9, 2)
tool('w7a', 1190, 'Bash', cmd='pnpm --filter @harborline/pdf test invoice.snapshot')

# drop None beats, rename from_ key, sort
for e in TL:
    if e.get("beat") is None: e.pop("beat", None)
    if "from_" in e: e["from"] = e.pop("from_")
TL.sort(key=lambda e: e["t"])

data = {
    "_meta": {
        "purpose": "Synthetic dataset for the buildd product demo video. All names, ids, repos, people and numbers are fictional.",
        "wallClockSeconds": TL[-1]["t"],
        "conventions": {
            "keys": "Every entity has a `key` (e.g. 'T3', 'w3'); cross-references use keys. The seed script mints UUIDs and maps keys → ids.",
            "idShort": "Tasks/missions carry `_idShort`: force the first 8 hex chars of the minted UUID to this so branch names (`buildd/<id8>-<slug>`) match.",
            "fieldNames": "Drizzle property names (camelCase) from packages/core/db/schema.ts. `table` is the SQL table name.",
            "underscoreFields": "Fields starting with `_` are NOT columns — notes, end-state targets, or display hints.",
            "timeline": "t = seconds from mission creation. Rows in entity lists are the INITIAL state; the timeline mutates them. `_statusAtEnd`/`_final` give the target end state for a static (non-replay) seed.",
            "relativeTimes": "'-3d' style values are relative to demo start.",
        },
    },
    "team": team, "users": users, "accounts": accounts, "runners": runners,
    "workspace": workspace, "roles": roles,
    "missions": [hero_mission, heartbeat["mission"]] + [b["mission"] for b in background],
    "taskSchedules": [heartbeat["schedule"]],
    "tasks": hero_tasks + [heartbeat["tick_task"]],
    "workers": workers + [heartbeat["tick_worker"]],
    "artifacts": artifacts,
    "missionNotes": mission_notes,
    "memories": memories,
    "heartbeatPastTicks": heartbeat["past_ticks"],
    "backgroundMissions": [{"missionKey": b["mission"]["key"], "tasks": b["tasks"]} for b in background],
    "timeline": TL,
}
with open(OUT, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
print(OUT, "events:", len(TL), "end t:", TL[-1]["t"])
