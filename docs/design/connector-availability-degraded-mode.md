# Connector Availability: Degrade, Don't Block

**Status:** Proposed
**Related:**
- `apps/web/src/app/api/workers/claim/route.ts` — connector pre-filter (lines 480–636) and injection block (lines 1791–2029)
- `apps/web/src/lib/claim-gates.ts` — `checkConnectorRouting`
- `apps/web/src/app/api/tasks/[id]/start/route.ts` — `/start` connector gate (lines 132–147)
- `packages/core/db/schema.ts` — `connectors`, `connectorWorkspaces`, `connectorShares`, `workspaceSkills.connectorRefs`
- `docs/specs/mcp-connectors-and-roles.md` — active unified model spec
- `docs/specs/credential-isolation.md` — pre-flight hard-fail spec

---

## Problem

A task filed with `roleSlug=researcher` and `connectorRefs` referencing connector `ec3922c1` sat in the
pending queue for 29 minutes with no alert and would have sat indefinitely. The error was discovered
only when a user manually inspected the UI and saw:

> "Task cannot be started: role 'researcher' requires connectors not available in this workspace"

The task had to be manually re-filed against a different role.

Three compounding failures produced this outcome:

1. **Silent deferral.** The batch claim path adds connector-mismatched tasks to `connectorMismatchTaskIds`
   and increments `deferrals.connector_mismatch`, but emits no notification. The task becomes
   permanently unclaimed without any observable state change.

2. **Taxonomy collapse.** The same `connector_mismatch` deferral covers three structurally distinct
   cases—a connector that was never configured in the workspace, one whose credentials expired, and one
   whose server is transiently unreachable—all producing identical outcomes with no diagnostic
   distinction.

3. **No MCP surface for self-service diagnosis.** There is no `list_workspace_connectors` action or
   equivalent. An agent cannot enumerate which connectors are visible to a given workspace without
   reading the database directly.

A fourth signal worth resolving: the weekly SDK ecosystem research scan uses the same `researcher` role
in the same workspace and _has_ been completing (PR #1608, 2026-08-06). Two identical role/workspace
pairs, two different claim outcomes—indicating the failing `connectorRef` was added to the role _after_
those completed runs, or was orphaned by a delete or team-move since then.

---

## Current State

### Claim route pre-filter

`apps/web/src/app/api/workers/claim/route.ts` lines 480–636 batch-check connector availability before
the dispatch loop. For each candidate task, it verifies that every `connectorRef` on the role is:

1. Not dangling (connector row exists in the fetch)
2. Owned by the task's team, or covered by a `connectorShares` grant
3. Not explicitly disabled via a `connectorWorkspaces` row with `enabled=false`

Tasks failing any check are added to `connectorMismatchTaskIds`. In the dispatch loop (line 910):

```ts
if (connectorMismatchTaskIds.has(task.id)) { deferrals.connector_mismatch++; continue; }
```

No notification fires. The task never claims.

### `/start` route hard-reject

`apps/web/src/app/api/tasks/[id]/start/route.ts` lines 132–147 calls `checkConnectorRouting` and
returns `422 routing_mismatch` if any refs are unresolvable. `forceOverride` does **not** bypass this
gate.

### `checkConnectorRouting`

`apps/web/src/lib/claim-gates.ts` lines 33–104. Returns `string[] | null` — the names of missing
connectors, or `null` if all are available. Performs the same three checks as the pre-filter. Does not
distinguish between the three failure modes.

### Connector data model

- `connectors`: owned by a team (`teamId`). `authMode ∈ {none, header, oauth, assertion}`.
- `connectorWorkspaces`: opt-out table — an absent row means **enabled** (current semantics).
- `connectorShares`: cross-team grants.
- `workspaceSkills.connectorRefs`: `string[]` of connector IDs the role mounts.

---

## Failure Taxonomy

The three failure modes are currently indistinguishable. They require different platform responses.

### Case A — NEVER_MOUNTED

**Detection:** The connector ID in `connectorRefs` has no row in `connectors`, OR the connector's
`teamId` does not match the task team and no `connectorShares` grant exists for this team.

**Meaning:** Permanent config drift. The ref was added to the role pointing at a connector that either
never existed in this team's context, was deleted, or was transferred to another team without a share
grant.

**Resolution:** Human action required. The role's `connectorRefs` must be updated or the connector
must be (re)created/shared.

**Default response:** Task runs degraded; connector tools are unavailable. UI shows persistent
`connector:missing` badge on the task. One Pushover notification fires on first deferral. The badge
persists until the role's refs are corrected.

### Case B — EXPIRED_OR_REVOKED

**Detection:** The connector row exists and is team-visible, but:
- `authMode=oauth` and `tokenExpiresAt` is in the past AND the refresh attempt returns `401` or
  `400` (invalid grant — token was revoked, not just stale)
- `authMode=header` or `authMode=assertion` and the backing `secrets` row is absent or the decrypt
  fails with a key error

**Meaning:** The connector is configured but its credentials are dead. Fixable without schema changes
by re-authorising the connector.

**Resolution:** Credential re-authorisation. The system can suggest the fix path in the notification.

**Default response:** Task runs degraded. UI shows `connector:auth_expired` badge. Pushover
notification includes the connector name and a link to the connector settings page.

**Note on oauth expiry ambiguity:** `tokenExpiresAt` in the past with a successful refresh is an
expected operational event (Case C). `tokenExpiresAt` in the past with a `401`/`400` on refresh is
Case B. The distinction must be made at refresh time, not pre-flight.

### Case C — TRANSIENT

**Detection:** The connector row exists, credentials are either non-expiring or a fresh token was
obtained, but the HTTP probe (see `credential-isolation.md` §2 `runMcpPreflight`) returns
`502`, `503`, or `504`.

**Meaning:** The connector's upstream server is temporarily unreachable. Prior runs worked; the server
may recover.

**Resolution:** Retry. No human action needed.

**Default response:** Task is held for retry, not immediately claimed. After N consecutive transient
failures (proposed: N=3, 10-minute backoff), escalate to the NEVER_MOUNTED/notify path.
`connector:transient` badge shown in UI during the retry window.

---

## Proposal

### Crux

The one decision the design turns on: **connectors default to advisory, not blocking.** A role's
`connectorRefs` declares intent, not a hard requirement. The task runs with whatever connectors
_are_ available. The agent's output records which were missing. The task does not sit forever.

If this default is wrong—if a connector is genuinely load-bearing for the task—the opt-in mechanism
(below) covers it. But the burden of proof inverts: config drift does not silence tasks by default.

### 1. Advisory-by-default claim behaviour

**Change:** Remove the `connectorMismatchTaskIds` hard-block from the dispatch loop. Replace with a
`connectorDegraded` metadata attachment on the claimed worker.

At claim time, the injection block (lines 1791–2029) already skips missing connectors for
`stdio` and `oauth` cases (AC-3/AC-4 in `mcp-connectors-and-roles.md`). Extend this to all failure
modes and attach a structured `degradedConnectors` field to the worker payload:

```ts
type DegradedConnector = {
  id: string;
  name: string;
  failureMode: 'never_mounted' | 'expired_or_revoked' | 'transient';
  detail?: string; // e.g. "token refresh returned 401", "HTTP 503 from https://..."
};
```

The runner receives `degradedConnectors` alongside `mcpConnectors`. It injects a system-prompt
notice: "The following connectors were unavailable at claim time and their tools are not mounted:
[names]. Proceed without them; note the gap in your output."

**Safety bound:** The advisory path only applies when `degradedConnectors.length < connectorRefs.length`.
If _all_ connectors for the role are unavailable (total degradation), hold the task with a notification
(same as the hard-required path below) rather than claiming a worker with no tools at all.

### 2. Load-bearing opt-in: `requiredConnectors`

A role cannot know whether a connector is essential for a given task. The task can.

**New field:** `tasks.requiredConnectors: string[] | null` — a subset of the role's `connectorRefs`
that must be fully resolved for this task to proceed. `null` (the default) means advisory for all.

**Precedence:**
1. `task.requiredConnectors` — task-level declaration wins. If set and non-empty, each listed
   connector is hard-required for this task regardless of role defaults.
2. _(future)_ A role-level `blockOnConnectorMismatch: boolean` default, if added. Not proposed here.

**Behaviour when a required connector is unavailable:**
- The task is NOT claimed (as today).
- A Pushover notification fires immediately (not on the Nth retry — once, then on state change).
- The task status shows `blocked:connector` with the specific connector name and failure mode.
- After 30 minutes with no resolution, a reminder notification fires.

**API surface:**
```
POST /api/tasks
{ ..., requiredConnectors: ["<connector-id>"] }
```

The claim route pre-filter is retained but scoped: `connectorMismatchTaskIds` is only populated for
tasks where the unresolvable connector appears in `task.requiredConnectors`.

### 3. Observability

**3a. Task detail badge**

When `degradedConnectors` is non-empty on a worker, the task detail page shows a yellow warning
badge: "Connector unavailable: [name] ([failure mode])". This badge persists on the task even after
the worker completes, so the audit trail records which runs were degraded.

**3b. Role/workspace connector config page**

The connector settings UI adds a health column: for each connector in the workspace, show
`OK | auth_expired | server_unreachable | not_configured`. This is a live read from the same
resolution logic as the claim route, not a stored health state.

**3c. Pushover notification on first stall**

When a task with `requiredConnectors` cannot claim due to a connector failure, fire a Pushover
alert within 60 seconds of the first missed claim attempt:

```
[buildd] Task blocked: connector unavailable
Task: "<title>" (workspace: <name>)
Role: <slug> | Connector: <connector-name> (<failure-mode>)
Fix: <deeplink to connector settings>
```

**3d. MCP surface gap — `list_workspace_connectors`**

The MCP `buildd` tool currently has no action to list which connectors are visible and healthy for a
given workspace. This blocked self-service diagnosis of the incident. A new `list_connectors` action
should be added (read-only, available at worker token level) returning:

```json
{
  "connectors": [
    { "id": "...", "name": "...", "authMode": "oauth", "status": "ok" | "auth_expired" | "unreachable" | "disabled" }
  ]
}
```

This is an observability gap, not a core part of the advisory-mode change. It should ship alongside
or shortly after.

### 4. Failure-mode detection at claim time

Extend `checkConnectorRouting` (and the batch pre-filter) to return typed failure objects:

```ts
type ConnectorFailure = {
  connectorId: string;
  connectorName: string;
  mode: 'never_mounted' | 'expired_or_revoked' | 'transient';
};

// Returns null if all available, array of failures otherwise
function checkConnectorRouting(...): Promise<ConnectorFailure[] | null>
```

**Detection logic additions:**

- **NEVER_MOUNTED**: current dangling/wrong-team/disabled checks — already implemented.
- **EXPIRED_OR_REVOKED**: for `authMode=oauth`, attempt the token refresh inline (or read
  `tokenExpiresAt` + `lastRefreshedAt`; if `lastRefreshedAt < now - 5min` AND `tokenExpiresAt < now`,
  classify as expired pending retry). For `authMode=header` or `stdio`, attempt secret decryption; a
  missing or corrupt secret row = `expired_or_revoked`.
- **TRANSIENT**: HTTP HEAD probe to the connector's `url` with a 3-second timeout; `5xx` = transient.
  This probe is the existing `runMcpPreflight` pattern. Only runs when the connector passed the
  NEVER_MOUNTED and EXPIRED checks.

The HTTP probe adds latency to the claim path. Gate it behind the connector's `transport` field
(only for `transport=http`) and cap total probe time per claim at 5 seconds (skip remaining probes
if budget exceeded, treating skipped as `transient`).

### 5. Role/routing hygiene

The triggering task was pure codebase investigation (grep + `query_knowledge`). The organizer
chose `researcher` because the task was phrased as research, but the researcher role's `connectorRefs`
include connectors the task did not need. The mapping was role-first rather than capability-first.

**Proposed organizer guidance (to be added to the organizer role's system prompt):**

> When selecting a role for a task that is primarily codebase investigation (grep, read files,
> query knowledge), prefer `builder` unless the task requires live external data (web search, API
> calls, third-party tool access). The `researcher` role mounts external connectors; choosing it
> for internal analysis adds connector dependencies that may not be satisfied.

**Claim-time role suggestion (nice-to-have, not blocking):**

If a task's connector check fails and a sibling role in the same workspace with no `connectorRefs`
(or with all refs resolvable) could handle the same `skillSlugs`, surface that role name in the
`connector_routing_mismatch` error response:

```json
{
  "error": "...",
  "gateReason": "connector_routing_mismatch",
  "missingConnectors": [...],
  "alternativeRole": "builder"
}
```

The `/start` route and the UI "Cannot start" modal can surface this suggestion. It does not
auto-reroute; routing remains a human or organizer decision.

---

## Incident Diagnosis

**Connector:** `ec3922c1-ef10-459d-ab85-7b9f24ab1d23`
**Role:** `researcher` (buildd workspace)
**Most likely failure mode: NEVER_MOUNTED**

The researcher role's `connectorRefs` array was updated (by a prior task or manual edit) to include
`ec3922c1`. This connector ID does not exist in the `connectors` table for the `buildd` team, was
never shared to the `buildd` team via `connectorShares`, OR was deleted after the ref was written.

Why earlier researcher runs succeeded: the SDK research schedule tasks (`PR #1608`, `PR #1605`) were
filed when the researcher role's `connectorRefs` either did not include `ec3922c1`, or the connector
existed at that time and was subsequently deleted. The role was modified between those runs and this
task.

**Verification steps** (blocked by the MCP gap noted in §3d above):

1. Read `workspaceSkills` where `slug='researcher'` and `teamId` = buildd team ID — check current
   `connectorRefs` value.
2. Query `connectors` where `id = 'ec3922c1-...'` — if absent, connector was deleted or never created.
3. Query `connectorShares` where `sharedWithTeamId` = buildd team ID and
   `connectorId = 'ec3922c1-...'` — check if a share grant was revoked.
4. Check `workspaceSkills` history (git log on migration files or audit log if available) to confirm
   when the ref was added.

**Interim remediation already applied:** Task manually re-filed as `585d828f` against `builder`.

**Recommended config fix:** Remove `ec3922c1` from the researcher role's `connectorRefs` in the
buildd workspace if the connector no longer exists, or restore/reshare the connector if it should
exist.

---

## Migration

Changing the default from block to advisory is a **behaviour change for existing tasks**. The migration
must be zero-surprise.

### Phase 1 — Dual-mode with a feature flag (default: block, opt-in: advisory)

Ship the advisory machinery (typed failures, `degradedConnectors` payload, notification) behind a
workspace-level feature flag `connector_advisory_mode: boolean` (default `false`). Workspaces that
opt in get the new behaviour; all others continue blocking.

### Phase 2 — Flip the default (advisory becomes standard)

After Phase 1 has been running for ≥2 weeks with no regressions:
- Set the flag default to `true`.
- Document the change in the release notes.
- Identify any roles whose `connectorRefs` are genuinely load-bearing and add
  `requiredConnectors` to their template tasks before the flip.

**Roles to audit before the flip:**

Roles with `connectorRefs.length > 0` where the connector tools are core to the role's function
(not incidental). In the buildd workspace, `researcher` is the primary candidate — if its connectors
are always required, add `requiredConnectors` to the SDK research schedule's task template.

### Phase 3 — Remove the flag

After Phase 2 has been stable for one release cycle, delete the feature flag and clean up any
conditional branches.

---

## Implementation Sketch (Proposed Task Breakdown)

The following tasks are ordered with the load-bearing piece (taxonomy + advisory claim) first.
Each is scoped to a single PR. Do not file these tasks until this spec is reviewed and accepted.

**T1 — Typed failure taxonomy in `checkConnectorRouting`**
Extend `ConnectorFailure` return type. Add `never_mounted` / `expired_or_revoked` / `transient`
detection logic. HTTP probe with 3s timeout, 5s total cap. Update claim route pre-filter and
`/start` route to consume typed failures. ~300 LOC + tests.
`Role: builder`

**T2 — Advisory-mode claim path**
Add `connector_advisory_mode` workspace flag. In the dispatch loop, when the flag is enabled and
the task has no `requiredConnectors`, replace the hard-skip with a `degradedConnectors` attachment
on the claimed worker. Add `degradedConnectors` to the worker payload schema in `packages/shared`.
Runner injects the degraded-connector notice into the system prompt.
`Role: builder` | depends on T1

**T3 — `requiredConnectors` field on tasks**
Schema migration: `tasks.required_connectors uuid[] null`. Claim route pre-filter respects this field
for the hard-block path. `/api/tasks` POST/PATCH accepts `requiredConnectors`. Organizer and UI task
creation form expose the field.
`Role: builder`

**T4 — Pushover notification on stall**
When a task with `requiredConnectors` misses claim due to connector failure, fire a Pushover
notification within 60s. 30-minute reminder if not resolved. Use the existing `send_notification`
pattern from the dispatch channel. Requires a new scheduled check or claim-event hook.
`Role: builder` | depends on T1, T3

**T5 — UI: connector health badge on task detail and role config**
Task detail page: yellow badge listing degraded connectors (name + failure mode). Role config page:
health column for each `connectorRef` (live check, not stored state). Use existing badge/warning
component patterns from the dashboard.
`Role: builder` | depends on T2

**T6 — MCP `list_connectors` action**
Add read-only `list_connectors` action to the `buildd` MCP tool (worker token level). Returns
connectors visible to the caller's workspace with live health status. Enables agent self-diagnosis.
`Role: builder`

**T7 — Role suggestion in `connector_routing_mismatch` error**
`/start` route and claim route return `alternativeRole` in the error body when a sibling role
with no/resolvable connectors could serve the same skill. UI "Cannot start" modal surfaces it.
`Role: builder` | depends on T1

**T8 — Organizer system prompt update**
Add the role-selection guidance note (prefer `builder` for codebase investigation) to the organizer
role's system prompt. Low-risk; ships as a skill update, no code deploy.
`Role: builder`

**T9 — Researcher role connector audit + remediation**
Audit current `connectorRefs` on the researcher role in the buildd workspace. Remove dangling refs.
Decide which connectors (if any) should become `requiredConnectors` on the SDK research schedule
task template.
`Role: builder` | depends on T3, T6

**T10 — Phase 2: flip advisory default**
After T1–T5 have been in production ≥2 weeks, change `connector_advisory_mode` default to `true`.
Update `docs/specs/mcp-connectors-and-roles.md` to reflect the new default behaviour.
`Role: builder` | depends on T2, T5

---

## Open Questions

**Q1: Should the HTTP probe happen at claim time or pre-flight?**
The existing `runMcpPreflight` in the runner (`apps/runner/src/mcp-preflight.ts`) already probes
connector health after claim. Moving it earlier (to claim time) catches transient failures before
a worker is allocated but adds latency to the claim hot path. Lean toward keeping the probe in
pre-flight and using claim-time type detection only for NEVER_MOUNTED and EXPIRED, which can be
determined statically without a network call.

**Q2: Should `degradedConnectors` block tool injection entirely, or inject a stub tool that explains the gap?**
Lean toward full omission (no stub). A stub tool that always returns "connector unavailable" is
transparent but risks the agent looping on it. Omission forces the agent to work from the system
prompt notice. If the agent needs the tool's schema to plan (e.g., Linear connector), a stub may be
worth revisiting.

**Q3: Should total degradation (all connectors missing) always block?**
The proposal says yes. An alternative is to let total degradation proceed with a stronger warning
and leave the agent to self-abort if it cannot proceed. Lean toward blocking on total degradation
because the advisory model assumes the agent can still do meaningful work; zero-connector implies
the role selection was wrong.

**Q4: Feature flag granularity — workspace or team?**
Proposed at workspace level. A team-level flag would be simpler (one flip covers all workspaces)
but coarser. Workspace-level lets one workspace migrate early before a full rollout. Start at
workspace level; promote to team default in Phase 2.

---

## Non-Goals

- **Automatic connector re-authorisation.** The system notifies; humans (or a dedicated credential-
  refresh task) do the fix. Auto-reauth for OAuth is already handled at claim time for token refresh
  (not revocation).
- **Dynamic connector selection.** The advisory model does not attempt to substitute a different
  connector when the declared one is unavailable. Substitution is a future routing intelligence
  capability.
- **Retry scheduling for TRANSIENT failures.** Retry backoff for transient connectors is scoped to
  T1's detection, not a full retry-queue implementation. The TRANSIENT case defers the task (as
  today) but with a bounded retry count and a notification on escalation.
- **MCP connector registry/browse.** Out of scope; covered by `docs/design/generic-mcp-connectors.md`.
- **Cross-workspace connector availability.** The `connectorShares` model is not changed by this
  design. Cross-team share grants are part of the NEVER_MOUNTED detection but not re-designed here.
