---
title: Team Service Status
status: draft
owner: max
last_verified: 2026-10-11
summary: A team MUST see one plain-language service status per root cause, scoped to what each viewer may act on, never the platform's incident machinery, and never as a Needs You count unless a named person has a concrete action.
domain: surfaces
surfaces: [apps/web/src/lib/failure-incident-escalation.ts, apps/web/src/lib/home-attention.ts, apps/web/src/lib/incident-view.ts, apps/web/src/app/app/(protected)/health/member-scope.test.ts]
related: [team-permissions, credential-refresh-lifecycle, auth-oauth-boundaries, runner-liveness, human-in-the-loop-protocol, surface-ia-home-missions-initiatives]
keywords: [service status, runner needs sign-in, waiting for runner sign-in, quiet status surface, needs you, credential owner, incident, root cause, member, team admin]
verified_by: [apps/web/src/app/app/(protected)/health/member-scope.test.ts, apps/web/src/lib/failure-incident-escalation.test.ts, apps/web/src/lib/incident-view.test.ts, apps/web/src/lib/home-attention.test.ts]
supersedes: []
---

# Team Service Status

**Status of this document**: draft. The viewer-scoping of Health
(`member-scope.test.ts`) and the escalation gate exist today; the
service-status projection (section 6), the team-facing vocabulary (section 2)
and the credential-owner path (section 4) are not built. Each acceptance
criterion below names the test that MUST exist before this spec is promoted to
`active`. A name marked *(new)* does not exist yet and is plain text on purpose.

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
- **Operator-side recovery** lives in the buildd-admin repo
  (`docs/specs/operator-recovery.md`, read-only reference). The only contract
  between the two is the projection in section 6.
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

The only interface between this product and buildd-admin recovery tooling.
Admin storage, endpoints and topology are out of scope for this spec and MUST
NOT be named in it.

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

## Invariants

- No team-facing surface renders a banned term from section 2.
- No team status contributes to a badge count.
- A member never receives a field the viewer table marks absent for them.
- A credential-owner action is offered only to the owner of that credential.
- A status never triggers resumption, retry or a model-provider change itself.
- Two statuses for the same root cause and scope never coexist.

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

To be added by the implementation task: the projection module (inputs and
outputs in section 6) and the team-facing renderers.

## Out of scope

- Detecting, classifying severity of or fixing failures (Sentinel, fix tasks).
- Resuming interrupted work (mission `ecea17f3`, delivery kernel).
- Operator-side storage, endpoints and tooling (buildd-admin).
- Storing, refreshing, relaying or substituting any subscription login.
- Paging the platform owner (the escalation gate).
- Visual design of the status surface and banner.
