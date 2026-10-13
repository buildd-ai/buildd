---
title: Team Service Status
status: active
owner: max
last_verified: 2026-10-12
summary: Each viewer MUST see one plain status per root cause, actionable only by whoever controls the broken runner; Home never carries operator machinery, operator included.
domain: surfaces
surfaces: [apps/web/src/lib/service-status.ts, apps/web/src/lib/home-attention.ts, apps/web/src/lib/failure-incident-escalation.ts, apps/web/src/app/app/(protected)/health/member-scope.test.ts]
related: [team-permissions, credential-refresh-lifecycle, auth-oauth-boundaries, runner-liveness, human-in-the-loop-protocol, surface-ia-home-missions-initiatives]
keywords: [service status, runner needs sign-in, waiting for runner sign-in, quiet status surface, needs you, credential owner, incident, root cause, member, team admin, operator parity, hosted runner, self-hosted runner, runner owner, platform-owner API]
verified_by: [apps/web/src/lib/service-status.test.ts, apps/web/src/lib/team-incident-boundary.test.ts, apps/web/src/app/app/(protected)/health/member-scope.test.ts, apps/web/src/lib/failure-incident-escalation.test.ts, apps/web/src/lib/incident-view.test.ts, apps/web/src/lib/home-attention.test.ts]
assertions:
  - id: "escalation-rule"
    type: "symbol"
    name: "incidentEscalationRule"
    path: "apps/web/src/lib/failure-incident-escalation.ts"
  - id: "member-scope-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/health/member-scope.test.ts"
  - id: "escalation-tests"
    type: "test_file"
    path: "apps/web/src/lib/failure-incident-escalation.test.ts"
supersedes: []
---

# Team Service Status

**Status of this document**: active. The pure projection
(`apps/web/src/lib/service-status.ts`, section 6) and the operator gates on the
incident page, its API and Home's incident read have landed. Two gaps remain,
and sections 7 to 9 are the contract that closes them:

1. **Nothing renders the projection.** No loader builds its input from real
   data and no team surface shows its output, so a team sees no status at all.
2. **Home still carries operator machinery for whoever is the platform
   operator.** Incident cards and decision-feature health rows are gated on
   the operator role, not removed from Home. An operator is also a member of
   their own team, so their Home mixes platform machinery into "things need
   you". Gating by role kept the machinery off other teams' Home; it did not
   move it to the operator's surface.

Each acceptance criterion names the test that MUST exist; a name marked
*(new)* does not exist yet, is plain text on purpose, and is to be replaced
with the real file when it lands.

**Capability statement**: When something degrades the service a team's work
depends on, each person on the team MUST see it once, in words about their own
work, with an action only if they personally can take one.

## Relationship to existing work

This spec is the team-facing contract. It does not redo recovery.

- **Detection, triage and the platform's own recovery** stay with the Failure
  Pattern Sentinel and the incident store (`failure-incident-actions.ts`,
  `failure-incident-store.ts`, `failure-pattern-sweep.ts`). Nothing here
  changes when a pattern opens, who fixes it, or the fix task.
- **Who gets paged** stays with the escalation gate
  (`apps/web/src/lib/failure-incident-escalation.ts`, `incidentEscalationRule`).
  Its critical-incident and no-next-step rails page the platform owner. This
  spec adds a separate, team-scoped surface and rule; it does not loosen or
  tighten the owner's page.
- **Health scoping** (members see their own work and the runners they can use,
  team admins see the team; Operator stays the platform owner's) is fixed by
  `health/member-scope.test.ts` and the Health PRs that landed it. This spec
  reuses that split and extends it to service status.
- **Mission `ecea17f3`** (incident recovery) owns resuming interrupted work.
  Section 4 only states what the team sees while that happens and requires it
  to use the same resume authority.
- **Operator tooling** is a client of the platform-owner API, the same way any
  operator would build one on these routes. This product ships the API, not
  the client. The only contract a team surface has with it is the projection
  in section 6.
- **Credentials**: buildd coordinates the agent and does not provide model
  access. A subscription login stays on the runner machine that owns it (see
  `auth-oauth-boundaries`, `credential-refresh-lifecycle`). Nothing in this
  spec stores, refreshes, relays or substitutes a login. "Reconnect" always
  means the owner signs in on their own runner.

## 1. Visibility contract

Roles are the team roles of `team-permissions`; "team admin" is whoever holds
`manage_team_settings` (owner and admin). "Credential owner" is the person who
owns the runner account whose sign-in is affected; it is a relationship, not a
role, and a team admin is not a credential owner by virtue of being an admin.

| Fact | Member | Team admin | Credential owner |
|---|---|---|---|
| Which capability is affected (e.g. "Runs on Runner A") | Only if their work or a runner they can use is affected | Whole team | Their own runner |
| Condition in plain words | Yes | Yes | Yes |
| Effect on team work | Their own work only | All team work, with counts by workspace | Their runner's waiting work |
| Recovery state ("Waiting for runner sign-in", "Restored") | Yes | Yes | Yes |
| Linked work (tasks, PRs) | Their own | All in team | On their runner |
| Reconnect action for a runner's sign-in | No | No | Yes, own runner only |
| Coordinate: see who owns the sign-in, route work to another runner | No | Yes | No |
| Owner-of-sign-in's identity | Not shown | Shown | Self |
| Sentinel rule, signature, failure rate, incident id, account id, raw error | Never | Never | Never |
| Operator page, dispatch, gates, experiments | Never | Never | Never |

Visibility is decided server-side from the viewer's team membership and
runner ownership. A field a viewer may not see is absent from the payload, not
hidden by the client.

## 2. Vocabulary

A team-facing status is exactly these fields and nothing else:

- **Affected capability**: what the team uses, named for the team ("Runner A",
  "Pull request merging", "Task starts"), never the internal component.
- **Condition**: one plain sentence of what is wrong ("Needs sign-in",
  "Slower than usual", "Not responding").
- **Effect on team work**: what that does to the viewer's work in scope ("3
  tasks are waiting"), or "No work affected".
- **Recovery state**: one of `investigating`, `waiting_on_person`,
  `recovering`, `restored`. `waiting_on_person` names the role waiting, not an
  individual, for viewers who are not that person.
- **Next update**: shown only when a data-backed time exists (a scheduled
  retry, a known window). Absent otherwise; never a guessed estimate.

Banned in any team-facing string, including notification text, link labels,
empty states and aria labels: "incident", "Open incident", incident ids,
"Sentinel", failure-rate figures, account ids, UUIDs, and redaction
placeholders. The existing incident page and `incidentStateLine` /
`incidentAffected` (`incident-view.ts`) are operator vocabulary and stay on the
operator side; team UI MUST NOT render them.

## 3. Needs You rule

A status enters Needs You only when a named person can take a concrete,
authorized action that changes the outcome (reconnect a runner they own;
approve something they are authorized to approve). Then it is one card for
that person with the action and where it happens.

- **Passive impact** (a slowdown, a platform fix underway, waiting on someone
  else) goes to a quiet status surface, never Needs You. Teammates waiting on
  another person's action see it there.
- **Severe, widespread impact** (most of a team's work cannot start) MAY raise
  one banner on Home and Health, until restored.
- A status MUST NOT contribute to any badge count, including the Needs You
  badge. A banner is not a count and a count is not a banner.
- The escalation gate's owner verdicts (`owner: 'person'` rails) are not Needs
  You items for team members. They continue to reach the platform owner only.

## 4. Known credential state

| Situation | Credential owner sees | Team admin sees | Other members see |
|---|---|---|---|
| Runner's subscription sign-in is expired or revoked | **"Runner needs sign-in"**: runner and provider, the waiting work, a real reconnect path | "Runner A is waiting for its owner to sign in"; may route work to another runner | **"Waiting for runner sign-in"** on affected work |
| Platform-managed failure (hosted runner, provider outage, platform bug) | Service impact only | Service impact only | Service impact only |
| Cause unknown | Honest generic status | Honest generic status | Honest generic status |

Rules:

1. The reconnect path is a real one: the existing sign-in on the owner's own
   runner machine (`claude login`, `CLAUDE_CODE_OAUTH_TOKEN`), or the
   owner-initiated reconnect flow that already exists for that provider. If no
   real path exists for a provider, the status states the condition without an
   action and does not enter Needs You.
2. A platform-managed failure never asks anyone to sign in or reconnect, since
   no person holds the fix.
3. **Clear only on verified capability.** The status clears when a check on
   the affected runner/provider succeeds, not when the owner clicks, not when a
   timer lapses.
4. **Resume through existing authority.** Interrupted work resumes via the
   workflow authority that owns it (the delivery kernel and the task lifecycle
   recovery of mission `ecea17f3`). The status surface triggers nothing itself.
5. **No duplicate execution and no paid-provider fallback.** Resumption MUST
   NOT start a second run of work that is still live, and MUST NOT move
   subscription work onto an API-key account or a different paid provider to
   get around the missing sign-in. Choosing another runner is a team admin's
   explicit decision.

## 5. Correlation

- One root cause produces one status per authorized scope (member, team admin,
  credential owner), with all affected work linked from it, however many
  tasks, workers or PRs hit it.
- Known causes are classified deterministically from structured fields (error
  class, runner/account state), never from free text. An unknown cause, or one
  below the classifier's confidence, is shown as an honest generic status
  ("Something is slowing work; we are looking at it"), never a guessed specific
  cause.
- A status clears on verified recovery (section 4.3). A repeat of the same root
  cause after it cleared reopens the same status without a new notification;
  a new notification is sent only for a root cause that was not already
  active for that scope.
- An escalation gate fingerprint and a status are separate objects. The gate
  decides whether the owner is paged; the status decides what the team sees.
  Neither reads the other's "sent" flag.

## 6. Service-status projection contract

The only interface between team surfaces and operator tooling. Operator
clients, their storage and their topology are out of scope for this spec and
MUST NOT be named in it.

**Input** (per team, produced by detection/classification, read-only to the
projection): zero or more root-cause records, each with a stable root-cause
key, a capability reference (runner / provider / platform component), a
classification (`credential_expired`, `platform_managed`, `unknown`, or another
deterministic known cause), first and last seen times, affected work references
(task and PR ids), and a verified-restored time if one exists.

**Output** (per team, per viewer scope): a list of statuses, each with the
section 2 fields, a stable status key (derived from the root-cause key and
scope, not shown), the linked work the viewer may see, the viewer's available
action (`reconnect` for the credential owner, `route_work` for team admins, or
none), and an `attention` value of `needs_you`, `banner` or `quiet`.

**Properties**:
- Scoped by team: a status for team A is never present in team B's output.
- Pure with respect to the input: the same input and viewer give the same
  output; no model call on the read path.
- Contains none of the banned fields in section 2.
- Never produces `needs_you` without an `action` the viewer holds.

## 7. Surface placement: Home is a team surface for everyone

Home, Health and the Needs You badge are team surfaces. They render the same
thing for a platform operator as for any other team admin with the same team
role. The operator role adds nothing to them.

- **Leaves Home for every viewer, the operator included**: Sentinel incident
  cards (the stored escalation verdicts), decision-feature health rows ("…is
  not deciding", the decision collection items), and any other item whose
  subject is buildd's own machinery rather than the team's work.
- **Where it goes**: operator tooling, which reads root causes through the
  platform-owner API and keeps its own state. Team surfaces carry no operator
  items. The operator's push page for an owner verdict is unchanged; only
  its Home card goes. Moving them MUST NOT leave the operator without them:
  the platform-owner API serves the same items, with the same verdicts, before
  Home stops rendering them.
- **What the operator sees on Home instead**: the section 6 projection for
  their own team, at their team role, like anyone else. A Sentinel pattern
  that hit their team's work reaches them as a team status ("Runner A needs
  sign-in"), not as an incident.
- **Failed tasks** stay on Home as failed tasks. A failed task whose cause is
  an active classified root cause (section 5) is linked from that status and
  does not get a card of its own: one cause, one item.

## 8. Who resolves: runner ownership decides the action

The fix for a failure depends on who controls the thing that broke. That is
read from structured fields of the runner account the work was claimed on, never
from error text. Team admins are the primary audience: they control which
runners serve the team, so every runner status reaches them, and they are
the fallback whenever no other person can act.

| Runner (read from the runner account) | Cause | Who acts | Action | Team admin sees |
|---|---|---|---|---|
| **Personal self-hosted**: subscription sign-in (`authType` `oauth`), not managed, created by a member | Sign-in expired or revoked | That member (credential owner) | Sign in on their own machine (`claude login`, `codex login`) | "Runner A is waiting for its owner to sign in", who owns it, the waiting work, and route-to-another-runner |
| **Shared self-hosted**: a host runner the team registered (`hostRunner`), or one whose creator is no longer on the team | Sign-in expired or revoked | Team admins | Sign in on that machine | The same card as the person acting, since they are the one acting |
| **Self-hosted with an API key** (`authType` `api`) | Key rejected | The team admin, if the key is a team provider credential; the runner's owner, if the key is set on the machine | Replace the key in Settings, or on the machine | The coordination view |
| **Hosted** (`managedRunner`, buildd Pro) | Team API key rejected | Team admins | Replace the key in Settings | The action card |
| **Hosted** | Runner infrastructure, provider outage, platform bug | No one on the team | None: `platform_managed`, service impact only | Service impact, and a banner if widespread |
| Any | Cause unknown | No one | None: honest generic status | Generic status |

Rules:

1. **Hosted runners never ask for a subscription sign-in.** They run on API
   keys only, so `credential_expired` on a hosted runner is a key problem
   for team admins or a platform problem, never "sign in".
2. **One action holder per status.** The table picks exactly one person or
   role. Everyone else in scope gets the quiet status (section 3).
3. **Fallback to team admins.** When the credential owner cannot be
   resolved (creator removed, no creator recorded), the action goes to team
   admins rather than to no one.
4. **A login is never stored to fix it.** Every "sign in" action happens on
   the runner machine that owns the login. A provider credential that buildd
   still stores server-side (the custody path being removed) is classified
   by who saved it: a team-scoped row is a team admin's, and the action is to
   remove it and sign in on the runner, not to paste a fresh login into
   buildd.
5. **Members see only their own work.** A member whose work waits on someone
   else's runner sees "Waiting for runner sign-in" on that work, and never
   the owner's identity (section 1).

## 9. Wiring: a loader feeds the projection

The projection is pure; a loader builds its input from real data, once per
Home or Health render, with no model call.

- **Signals read**: runner accounts with a recorded sign-in or key failure
  (with `authType`, `managedRunner`, `hostRunner`, creator, team role of the
  creator), active Sentinel patterns for the team's workspaces, and the
  failed or waiting tasks attributed to each.
- **Classification** maps each signal to one section 8 row deterministically.
  A Sentinel pattern is input to correlation; it never reaches the projection
  output under its own name.
- **Render**: `needs_you` → one Home card for the action holder only; `banner`
  → one banner on Home and Health; `quiet` → the status list on Health and
  on affected task pages. None adds to a count (section 3).
- **Clear**: a status clears only on a verified capability check (section 4.3).
- **Failure of the loader** is non-fatal: Home renders without statuses and
  logs, like every other Home read.

## Invariants

- No team-facing surface renders a banned term from section 2.
- No team status contributes to a badge count.
- A member never receives a field the viewer table marks absent for them.
- A credential-owner action is offered only to the owner of that credential.
- A status never triggers resumption, retry or a model-provider change itself.
- Two statuses for the same root cause and scope never coexist.
- Home, Health and the Needs You badge give the same items to a platform
  operator as to a non-operator with the same team role.
- No Home item has buildd's own machinery as its subject (incidents, decision
  features, experiments).
- A hosted runner never produces a sign-in action.
- Every runner status with an action has exactly one action holder, and team
  admins hold it when no credential owner can be resolved.

## Acceptance criteria

The mission's seven acceptance criteria, each mapped to the test that asserts
it. Tests marked *(new)* are to be written by the implementation task; the
others exist and cover the neighbouring behaviour.

- AC-1: GIVEN a member, a team admin and a credential owner of the same team
  WHEN the projection is read for each THEN each payload contains only the
  fields the section 1 table allows for that viewer.
  Test: `team-service-status.visibility.test.ts` *(new)*, extending the
  existing `member-scope.test.ts` ("a member's Health").
- AC-2: GIVEN any status WHEN rendered in team UI, notification text or link
  labels THEN it contains none of "incident", "Open incident", an incident id,
  "Sentinel", a failure-rate figure, an account id or a redaction placeholder.
  Test: `team-service-status.vocabulary.test.ts` *(new)*; the guard against
  regressions in `incident-view.test.ts` keeps incident phrasing out of team
  paths.
- AC-3: GIVEN a status with no person holding a concrete action WHEN Home and
  the Needs You badge are computed THEN it is absent from the list and adds 0
  to every badge count, and a severe widespread status adds a banner only.
  Test: `home-attention.team-status.test.ts` *(new)*, next to
  `home-attention.test.ts` and `needs-input-count.test.ts`.
- AC-4: GIVEN an expired subscription sign-in on a runner WHEN the three
  viewers read the projection THEN the owner gets "Runner needs sign-in" with
  runner, provider, waiting work and a reconnect action, a team admin gets the
  coordinate/route option, other members get "Waiting for runner sign-in", and
  a platform-managed failure gives service impact only with no action.
  Test: `team-service-status.credential.test.ts` *(new)*.
- AC-5: GIVEN a sign-in status WHEN the owner reconnects but the capability
  check fails THEN the status stays, and GIVEN the check passes THEN it clears
  and interrupted work resumes only through the existing workflow authority,
  with no duplicate run and no paid-provider fallback.
  Test: `team-service-status.recovery.test.ts` *(new)*; the existing refresh
  invariants are asserted in `credential-refresh/route.test.ts`.
- AC-6: GIVEN many tasks failing from one root cause WHEN the projection is
  read THEN there is one status per scope with all work linked; GIVEN an
  unclassified cause THEN the status is generic; GIVEN a cleared cause that
  repeats THEN the same status reopens with no new notification.
  Test: `team-service-status.correlation.test.ts` *(new)*.
- AC-7: GIVEN a projection input for team A WHEN team B's viewer reads THEN B's
  output contains nothing from A, and the output carries no admin storage or
  endpoint identifier.
  Test: `team-service-status.projection.test.ts` *(new)*.
- AC-8: GIVEN a platform operator who is a team admin of their team, and an
  open owner-verdict incident and a decision feature that is not deciding
  WHEN their Home and Needs You badge are computed THEN neither item is
  present, the badge equals a non-operator team admin's, and the platform-owner
  API returns both items with their verdicts.
  Test: `home-operator-parity.test.ts` *(new)*; replaces the "loads incident
  cards onto Home only for a platform operator" case in
  `team-incident-boundary.test.ts`.
- AC-9: GIVEN each runner row of the section 8 table with its failure WHEN the
  projection is read for the credential owner, a team admin and a member THEN
  the action goes to the holder that row names, a hosted runner never yields a
  sign-in action, and a runner whose creator left the team yields the action
  for team admins.
  Test: `team-service-status.ownership.test.ts` *(new)*.
- AC-10: GIVEN a runner account with a recorded sign-in failure and tasks
  waiting on it WHEN Home renders for its owner THEN one "Runner needs sign-in"
  card appears, the waiting tasks' own failed cards do not, and the Needs You
  count rises by exactly one for the owner and by zero for anyone else.
  Test: `service-status-loader.test.ts` *(new)*.
- AC-11: GIVEN the status loader throws WHEN Home renders THEN Home renders
  every other item and no status.
  Test: `service-status-loader.test.ts` *(new)*.

## Code surface

Existing, read-only context for this spec:

- `apps/web/src/lib/failure-incident-escalation.ts` — owner paging gate;
  `incidentEscalationRule`, `incidentNeedsYouItems`.
- `apps/web/src/lib/home-attention.ts` — Home card rules, `waitsOnBuildd`.
- `apps/web/src/lib/action-queue.ts` — Needs You queue items.
- `apps/web/src/lib/incident-view.ts` — operator-side incident wording.
- `apps/web/src/app/app/(protected)/health/` — Health pages and
  `member-scope.test.ts`.
- `apps/web/src/lib/permission-registry.ts` — `manage_team_settings`,
  `view_team_usage`.

- `apps/web/src/lib/service-status.ts` — the pure projection:
  `correlateSignals`, `projectServiceStatus`, `statusAttentionItems`,
  `reconcileServiceStatus`.
- `apps/web/src/app/app/(protected)/home/page.tsx` — Home's reads; the
  operator-gated incident and decision-collection reads that section 7 removes.
- `packages/core/db/schema.ts` — `accounts.authType`, `managedRunner`,
  `hostRunner`, `createdByUserId`: the section 8 inputs.

To be added: the section 9 loader, the team-facing renderers on Home and
Health, and the platform-owner API routes for incidents and decision-feature
health.

## Out of scope

- Detecting, classifying severity of or fixing failures (Sentinel, fix tasks).
- Resuming interrupted work (mission `ecea17f3`, delivery kernel).
- Operator clients of the platform-owner API, their storage and their UI.
- Storing, refreshing, relaying or substituting any subscription login.
- Paging the platform owner (the escalation gate).
- Visual design of the status surface and banner.
