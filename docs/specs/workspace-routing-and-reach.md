---
title: Workspace Routing and Reach
status: draft
owner: max
last_verified: 2026-10-19
summary: Every task MUST be filed into the workspace its subject lives in, with the reason recorded, and MUST reach any other workspace only through a named, person-granted delegation checked before it runs.
domain: tasks
surfaces: [apps/web/src/app/api/tasks/route.ts, packages/core/token-delegation.ts, apps/web/src/lib/task-token-auth.ts, apps/web/src/app/api/workers/claim/delegation-gate.ts]
related: [capability-requests, team-permissions, credential-isolation, mission-heartbeat-schedule-lifecycle]
keywords: [workspace routing, home workspace, task token reach, bldt_, delegation, schedule delegation, task delegation, filingTargets, readsFrom, analytics:read, tasks:create, delegation_required, delegation_unmet, FORBIDDEN, not visible to this key, __coordination, schedule move, re-home, wrong workspace]
verified_by: [packages/core/__tests__/token-delegation.test.ts, apps/web/src/lib/schedule-delegation-scenario.test.ts, apps/web/src/lib/task-delegation-scenario.test.ts, apps/web/src/lib/task-token-routes.test.ts]
supersedes: []
assertions:
  - id: "delegation-claim-gate-symbol"
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: "symbol"
    name: "checkDelegationGate"
    path: "apps/web/src/app/api/workers/claim/delegation-gate.ts"
  - id: "task-token-reach-check"
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: "symbol"
    name: "taskScopeAllowsWorkspace"
    path: "apps/web/src/lib/task-token-auth.ts"
  - id: "delegation-regression-tests"
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: "test_file"
    path: "packages/core/__tests__/token-delegation.test.ts"
---
# Workspace Routing and Reach

A task has exactly one **home** workspace. The home decides almost everything
about the run, so a wrong home is not a permissions problem to patch with
grants: it is a routing bug. This spec separates three questions that today
share one column:

| Question | Name here | Today |
|---|---|---|
| Where does it run? (repo, runners, connectors, roles, knowledge) | **home** | `tasks.workspaceId`, fixed at filing |
| What may it read or file elsewhere? | **reach** | home ∪ delegation grants |
| What is it about? | **subject** | not recorded anywhere |

Sections 1–3 describe what holds on `dev` today (marked **[is]**). Sections
4–6 are the proposed contract (marked **[proposed]**), with the decisions it
needs in §7. Known discrepancies between code, docs and intent are in §8.

## 1. Home: what a task's workspace binds [is]

**Capability statement**: A task's home MUST determine its checkout, its
claimers, its connectors, roles and skills, its knowledge namespace and its
token's reach, and MUST NOT change after filing.

**Invariants**:
- I-1: `tasks.workspaceId` is written once, at insert. No route or helper
  updates it; a PATCH that sends `workspaceId` ignores it
  (`apps/web/src/app/api/tasks/[id]/route.ts`).
- I-2: The runner checks out the home's `repo` (or the task's PR repo), and
  only accounts that can claim in the home (own-team open workspace, or a live
  `account_workspaces` link with `canClaim`) are offered the task.
- I-3: Connectors are those enabled for the home (`connector_workspaces`) and
  opted into by the task's role; roles and skills resolve in the home, and a
  `roleSlug` the home lacks files the task role-less.
- I-4: A per-task token (`bldt_`) reaches exactly its home, plus the grants in
  §3. Every other workspace answers 404, by design, not 403.

**Consequence**: a task homed in the wrong workspace runs against the wrong
repo, may be claimed by the wrong runners, misses connectors and roles, reads
the wrong knowledge, and every read of the workspace it is actually about
comes back as "not visible to this key" or FORBIDDEN.

## 2. How the home is chosen today [is]

There is no single resolver. Each creation path picks a home by its own rule,
and none of them checks the home against the task's subject.

| Path | Home |
|---|---|
| `POST /api/tasks`, explicit `workspaceId` | resolved by `resolveWorkspaceAccess` (id, `owner/repo` or name; an ambiguous name is an unordered pick) |
| `POST /api/tasks`, task token, none given | the token's own home |
| `POST /api/tasks`, account key, none given | `autoResolveAccountWorkspace`: only if exactly one `canCreate` link, else 400 |
| MCP `create_task`, none given | the session's bound workspace; for an unrestricted account key, a guess from its visible tasks |
| Chat | the pinned conversation workspace, else a routing pick; the approval card says "this workspace" |
| Schedule tick | `schedule.workspaceId`, else the mission's, else `getOrCreateCoordinationWorkspace` |
| Planner children | the planning task's home; a plan step cannot name one |
| Retries, repairs, reviewers, follow-ups, continuations | the source task's home (delegation inherited) |
| Mission-owned creators (evaluation, criteria, verification) | the mission's workspace; skipped when it has none |
| System auto-filers (health, incidents, scouts, chat retro) | the trigger object's workspace; chat retro takes the most common one |
| Friction reports | "the same workspace" (CLAUDE.md), i.e. the reporter's home |
| GitHub issue intake | the first workspace whose repo matches, with no team filter |

**Invariants**:
- I-5: When MCP `create_task` names a workspace the caller cannot see,
  `unknownWorkspaceMessage` tells the agent to file in a visible workspace and
  name the real destination in the description. This is the path that put an
  analysis of one workspace's data into another workspace.
- I-6: `requireExplicitWorkspace` refuses an unpinned multi-workspace
  `create_task` for OAuth callers only; unrestricted account keys are not
  checked.

## 3. Reach: delegation [is]

**Capability statement**: A task MUST reach a workspace other than its home
only through a grant a person made, naming that workspace and a capability,
inside the task's own team.

**Invariants**:
- I-7: A grant is `{ workspaceId, capabilities }` with capabilities from
  `analytics:read` and `tasks:create` (`packages/core/token-delegation.ts`).
  It lives on a schedule (`task_schedules.delegation`, applies to tasks that
  schedule spawns while the schedule's workspace equals the task's) or on a
  task (`tasks.delegation`, inherited by retries and continuations).
- I-8: Only a person writes a grant. A schedule grant needs
  `delegate_schedule_access` (owner or admin by default) through
  `PATCH /api/workspaces/[id]/schedules/[scheduleId]`. A task grant is set at
  creation or before claim by a person who reaches each target, or by
  approving a `tasks:create` capability request.
- I-9: At use, `loadTokenDelegationsOrThrow` narrows grants to the task's team
  and the minting key's workspace list, and fails closed. Grants are re-read
  per request, cached at most 60 s, and the cache is cleared on every write.
- I-10: Only routes that call `taskScopeAllowsDelegated` honour a grant:
  `POST /api/tasks` (`tasks:create`), `GET /api/workspaces`,
  `GET /api/decisions`, `GET /api/stats/coordination` and
  `GET /api/health/failures` (`analytics:read`). Every other route uses
  `taskScopeAllowsWorkspace` and stays home-only, `GET /api/stats/usage`
  included.
- I-11: A declared `filingTargets` entry without a matching grant holds the
  task at claim with `delegation_unmet`. There is no declared need for reads,
  so a task that needs `analytics:read` elsewhere is not held: it runs and
  fails mid-run.
- I-12: None of the capability-request policy, `capability_policies` or the
  agent-capability broker grants reach into another buildd workspace, except
  the `tasks:create` request in I-8. `request_capability` with
  `analytics:read` means an analytics **connector** (connector domain
  `analytics`), not buildd's own decision or usage data. Being in the same team
  grants nothing by itself.

**Acceptance criteria** (pinned today):
- AC-1: GIVEN a task token with no grant WHEN it files a task in another
  workspace THEN `POST /api/tasks` answers 403 `delegation_required`
  (`apps/web/src/lib/task-delegation-scenario.test.ts`).
- AC-2: GIVEN a schedule grant of `analytics:read` on workspace B WHEN a task
  that schedule spawned reads `GET /api/decisions` for B THEN it gets the
  data; WHEN the grant is removed THEN the next read is refused
  (`apps/web/src/lib/schedule-delegation-scenario.test.ts`).
- AC-3: GIVEN a grant naming a workspace of another team WHEN the token is
  used THEN the grant is dropped and the read is refused
  (`packages/core/__tests__/token-delegation.test.ts`).
- AC-4: GIVEN a declared filing target with no grant WHEN a runner claims
  THEN the task is held with `delegation_unmet`.

## 4. Routing: one resolver, a recorded reason [proposed]

**Capability statement**: Every creation path MUST choose the home through one
resolver that returns the home and why, and the reason MUST be stored on the
task and shown wherever a person approves the task.

**Invariants**:
- I-13: The resolver takes, in order, and stops at the first that applies:
  1. **explicit**: the caller named a workspace;
  2. **subject**: the caller declared what the task is about (a repo, or the
     workspace whose data it reads or changes), and exactly one reachable
     workspace in the team matches;
  3. **source**: the task continues another object (retry, repair, review,
     plan step, mission criterion), whose home it inherits;
  4. **schedule / mission**: the schedule's or mission's workspace;
  5. **caller default**: the caller's own home.
  It returns `{ workspaceId, source, reason }`, stored on the task as
  `context.workspaceRouting`.
- I-14: Step 5 MUST NOT be taken silently when a subject was declared and
  points elsewhere. The resolver then answers with the subject's workspace and
  what is missing (`delegation_required` for a task token), never the
  caller's home.
- I-15: An unknown or unreachable workspace name MUST NOT be answered with
  "file it somewhere visible". The answer names the reachable workspaces and
  the two legitimate ways forward: file it in the subject's workspace with a
  grant (`request_capability` `tasks:create`), or hand it to a person.
- I-16: Every caller that reaches more than one workspace MUST name one or
  declare a subject; the multi-workspace guard in I-6 applies to account keys
  too.
- I-17: Approval cards (chat, plan approval, capability request) show the
  home's name and the routing reason, never "this workspace".
- I-18: Platform friction (a buildd tool or route misbehaving) is filed in the
  team's platform workspace (§7 D-1), not in whatever workspace the reporter
  happened to be in. Friction about the reporter's own repo stays home.

**Acceptance criteria**:
- AC-5: GIVEN a task token homed in A WHEN it calls `create_task` with a
  subject of workspace B and no grant THEN the call is refused with
  `delegation_required` naming B, and no task is created in A.
- AC-6: GIVEN `create_task` names a workspace the caller cannot see WHEN it
  is refused THEN the message does not suggest filing in a visible workspace.
- AC-7: GIVEN any created task THEN `context.workspaceRouting.source` is one
  of explicit, subject, source, schedule, mission, caller_default.
- AC-8: GIVEN an unrestricted account key reaching two workspaces WHEN it
  calls MCP `create_task` with neither a workspace nor a subject THEN it is
  refused, and nothing is created.

## 5. Declared reads, held before the run [proposed]

**Capability statement**: A task that needs to read another workspace MUST
say so when it is filed, and MUST be held, not started, until a grant covers
it.

**Invariants**:
- I-19: Task context accepts `readsFrom: [{ workspaceId, capabilities }]`,
  the read counterpart of `filingTargets`. Like it, it is a declared need,
  never a grant.
- I-20: The claim pre-flight treats an uncovered `readsFrom` entry exactly
  like an uncovered filing target: held with `delegation_unmet`, shown to a
  person who can grant it, with one action that writes the grant.
- I-21: The pre-flight and the routes apply the same reach rule. Today the
  pre-flight also requires the claiming account to reach the target for
  `analytics:read` while the routes check team plus grant; one of the two
  changes so both agree (§7 D-3).
- I-22: Every route in the analytics family (`GET /api/stats/usage`,
  `GET /api/health/dispatch`, `GET /api/explain` and the error-trace reads
  included) honours an `analytics:read` grant, and every MCP analytics tool
  answers with the read statuses `OK`, `NO_DATA`, `FORBIDDEN`, `UNAUTHORIZED`
  or `TOOL_UNAVAILABLE` (`formatAnalyticsReadFailure`), not a raw error.

**Acceptance criteria**:
- AC-9: GIVEN a task with `readsFrom` B and no grant WHEN a runner claims
  THEN the task is held with `delegation_unmet` and is not started.
- AC-10: GIVEN a schedule grant of `analytics:read` on B WHEN its task calls
  `get_usage_stats` for B THEN it gets data, not "not visible to this key".
- AC-11: GIVEN no grant WHEN any MCP analytics tool reads B THEN the answer
  starts with `FORBIDDEN` and says it is not evidence of zero rows.

## 6. Schedules that re-home themselves [proposed]

A schedule is the one thing whose home is chosen once and then produces
tasks indefinitely, so a wrong home repeats. The fix is to let the run that
notices it say so, and to let a person accept it once.

**Capability statement**: A task spawned by a schedule MUST be able to propose
that the schedule's future runs start in another workspace, and the move MUST
take effect only when a person with `delegate_schedule_access` accepts it,
from the next run.

**Invariants**:
- I-23: An MCP action, proposed as `propose_schedule_move { workspace, reason }`,
  is available only to a task token whose task a schedule spawned. It records
  one open proposal per schedule (a newer one replaces it) and changes
  nothing else.
- I-24: The proposal is shown as a decision to people with
  `delegate_schedule_access`: current home, proposed home, the reason, and
  the evidence the run attached (for example the reads that came back
  FORBIDDEN).
- I-25: Accepting moves the schedule in one write, effective from the next
  tick. The current run and tasks already filed keep their home (I-1).
- I-26: Every move, through a proposal or through the schedule PATCH, is
  validated: target exists, is in the schedule's team, is not archived, and
  the person moving it can create tasks there. Otherwise 403 or 404 and
  nothing is written.
- I-27: A move re-evaluates the delegation instead of silently dropping it:
  grants on the new home are removed (it is home now), and if the old home
  is still read, the decision offers a grant on it in the same action.
- I-28: Every move is recorded (who, when, from, to, reason, proposal id) and
  the schedule's history shows it.
- I-29: A schedule whose run keeps being refused on one other workspace
  (the same FORBIDDEN on consecutive runs) proposes the move itself. This is
  the automatic version of I-23, and it still needs a person to accept it.

**Acceptance criteria**:
- AC-12: GIVEN a scheduled task WHEN it calls `propose_schedule_move` to B
  THEN one decision is created and the schedule's workspace is unchanged.
- AC-13: GIVEN an accepted proposal WHEN the next tick runs THEN its task's
  home is B, and the run already in flight stays in A.
- AC-14: GIVEN a person without `delegate_schedule_access`, or a target in
  another team WHEN they move a schedule (proposal or PATCH) THEN it is
  refused and nothing is written.
- AC-15: GIVEN a task not spawned by a schedule WHEN it calls
  `propose_schedule_move` THEN it is refused.

## 7. Decisions needed

Each lists the options and the recommendation, judged for a team of many
people and for many teams on one buildd, not only for one operator.

- D-1: **Where friction goes.**
  (a) the reporter's home, as today: fine for project friction, but platform
  friction from another team's agents never reaches the people who maintain
  buildd;
  (b) a per-team "platform workspace" setting: solves one team, still
  invisible to the operator;
  (c) classify on filing: friction about the reporter's own repo stays home;
  friction about buildd itself (a buildd MCP tool or route, a traced error
  signature) becomes a platform signal deduplicated by signature across
  teams, carrying only signature, tool, error code, buildd version and count,
  never task content, and an operator opens the fix task from it.
  **Decided: (c).** A team may opt in to attaching excerpts.
- D-2: **Who accepts a schedule move, and where it shows.**
  (a) always a person: a card on Home for the schedule's owner and holders of
  `delegate_schedule_access`, with Accept, Keep, and Accept with a read grant
  on the old home, plus a banner on the schedule;
  (b) auto-accept low-risk moves (same team, same repo) and post an FYI card
  with undo;
  (c) a team policy (forbidden, ask, auto) on the existing
  `capability_policies` machinery, as provider `buildd`.
  **Decided: (a) now, (c) later** with ask as the default. An unanswered
  proposal never blocks runs: the schedule keeps its current home.
- D-3: **One reach rule for delegated reads.**
  (a) team plus grant (the routes today);
  (b) team plus grant plus the claiming account's own access to the target
  (the claim pre-flight today, and what `docs/SPEC.md` already states: a
  delegation "never exceeds the minting account's reach");
  (c) a grant also links the account to the target.
  **Decided: (b).** It is the documented invariant, and with more people
  a restricted workspace (a client's data) stays closed to a runner that
  cannot access it, even when someone else granted the read. The routes'
  delegated check gains the account-reach test; a task held at claim is
  claimable by a runner that has access.
- D-4: **Inferring the subject.**
  (a) explicit only: the filer declares `repo`, `readsFrom` or
  `filingTargets`;
  (b) inferred as a suggestion: buildd reads repo and workspace mentions
  (as chat routing's named-workspace step does), records source `inferred`,
  and shows it on the approval card, but never files on it alone;
  (c) inferred and applied.
  **Decided: (a) for agents, (b) for people in chat.** An agent can always
  declare; a person typing in chat should not have to, but should see where
  the task will land before approving. (c) misroutes silently.
- D-5: **What `analytics:read` means. Decided: requests name a provider,
  not an abstract capability.** Today the string names three things: an
  API-key scope, a delegation capability, and a connector capability from an
  abstract vocabulary (`domain:verb`, where domain `analytics` resolves to
  PostHog). An agent that wants PostHog asks for PostHog, so that vocabulary
  is an abstraction over providers that nobody needs, and it is where the
  collision comes from.
  - A connector request names the provider and an access level that matches
    the gateway's existing risk classes:
    `request_capability { provider: posthog, access: read | write }`. The
    grant, the policy and the gateway's per-tool decision already work per
    provider and tool, so nothing below the request changes.
  - The `domain:verb` vocabulary stops being requestable or grantable. Its
    categories stay only as a search filter when an agent asks which
    connector the team has for something (`GET /api/connectors/capabilities`).
  - buildd's own capabilities keep their names under provider `buildd`:
    `tasks:create` and `analytics:read` on a named workspace. `analytics:read`
    then means one thing: buildd's coordination data about that workspace
    (decision ledger and stats, coordination and gate stats, failure
    analytics, usage, dispatch health, explain, error traces), never task
    content, memory, knowledge or code. Requesting it is a person decision
    that writes a task delegation, as `tasks:create` does.
  - capability-requests.md changes with this (its examples ask for
    `observability:query`).

## 8. Discrepancies found while writing this

Ordered by impact. Each becomes a task or a fix to another spec.

1. Any REST schedule PATCH can move a schedule to any workspace id, with no
   team, reach or existence check; only the delegation is dropped
   (`apps/web/src/app/api/workspaces/[id]/schedules/[scheduleId]/route.ts`).
   Fixed by I-26.
2. GitHub issue intake picks a workspace by repo with no team or installation
   filter. Needs a security review on its own.
3. Analytics reads have no declared need, so they fail mid-run (I-11). Fixed
   by §5.
4. `unknownWorkspaceMessage` steers agents into the wrong workspace (I-5).
   Fixed by I-15.
5. The analytics family honours delegation unevenly (I-10). Fixed by I-22.
6. An approved `tasks:create` request writes a delegation that outlives the
   grant's TTL, and retries inherit it.
7. A filer cannot read the child it filed in a delegated workspace (the
   mission-task read checks require the token's own home).
8. A workspace-less mission's schedule cannot hold a delegation (the PATCH
   route needs the schedule's workspace; the loader requires the schedule's
   and the task's workspace to match).
9. `docs/SPEC.md` (workspace-less missions), `mission-completion.md` and
   `team-workspace-mission-onboarding.md` AC-21 describe an explicit
   `workspaceId` per organizer task that a cloud task token cannot do, and
   do not mention `__coordination`.
10. `requireExplicitWorkspace` assumes account keys are workspace-scoped
    (I-6). Fixed by I-16.
11. Stale comments: `apps/web/src/lib/task-token.ts` (delegation read only
    from the schedule), `packages/core/mcp-tools.ts` (task tokens "always
    401" on the workspace list), `packages/core/token-delegation.ts`
    (FORBIDDEN explained only through schedules).

**Code surface**:
- Creation: `apps/web/src/app/api/tasks/route.ts`, `apps/web/src/lib/workspace-access.ts` (`resolveWorkspaceAccess`), `apps/web/src/lib/workspace-resolver.ts` (`autoResolveAccountWorkspace`), MCP `create_task` and `unknownWorkspaceMessage` / `requireExplicitWorkspace` in `packages/core/mcp-tools.ts`
- Schedules: `apps/web/src/app/api/cron/schedules/route.ts`, `apps/web/src/lib/orchestrator-workspace.ts` (`getOrCreateCoordinationWorkspace`), `apps/web/src/app/api/workspaces/[id]/schedules/[scheduleId]/route.ts`
- Reach: `apps/web/src/lib/task-token-auth.ts` (`taskScopeAllowsWorkspace`, `taskScopeAllowsDelegated`), `apps/web/src/lib/task-delegation.ts` (`loadTokenDelegationsOrThrow`), `apps/web/src/lib/task-delegation-checks.ts`, `packages/core/token-delegation.ts` (`formatAnalyticsReadFailure`)
- Claim hold: `apps/web/src/app/api/workers/claim/delegation-gate.ts`
- Tables: `tasks.workspaceId`, `tasks.delegation`, `task_schedules.workspaceId`, `task_schedules.delegation`, `account_workspaces` in `packages/core/db/schema.ts`

**Out of scope**: which workspaces a runner account may claim from (claim
ordering), connector credentials and the gateway (capability-requests.md),
team roles and permissions (team-permissions.md), cross-team sharing.
