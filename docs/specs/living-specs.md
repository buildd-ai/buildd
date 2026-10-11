---
title: Living Specs
status: draft
owner: max
last_verified: 2026-10-10
summary: A Living Spec MUST keep every revision immutable and readable as written, and two writers revising one draft MUST NOT silently overwrite each other; approval is a person's act on one revision.
domain: knowledge
surfaces: [apps/web/src/lib/specs/store.ts, apps/web/src/lib/specs/approval.ts, apps/web/src/lib/specs/pin.ts, apps/web/src/app/api/specs/[specId]/route.ts]
related: [artifacts-and-sharing]
keywords: [living spec, spec revision, expectedVersion, version conflict, normative, requirement id, approval, manage_specs, parent spec, pinned revision, specSource, approve_specs]
verified_by: [apps/web/tests/db/specs.test.ts, apps/web/tests/db/spec-approval.test.ts, apps/web/src/app/api/specs/[specId]/approve/route.test.ts, apps/web/src/lib/reviewer.test.ts, apps/web/src/lib/approve-plan.test.ts, apps/web/src/lib/specs/requirements.test.ts, apps/web/src/app/api/specs/[specId]/route.test.ts, apps/web/src/app/api/specs/[specId]/parent/route.test.ts, packages/core/__tests__/mcp-tools-specs.test.ts]
supersedes: []
---
# Living Specs

Governed intent, database-canonical for specs created through Buildd (decision
D-1; repo-owned `docs/specs` stay Git-canonical).
Owned by Living Specs: only `apps/web/src/lib/specs/` writes `specs` and
`spec_revisions` (docs/specs/execution-control-plane.md).

## 1. Identity and immutable revisions

**Capability statement**: A spec MUST have a stable identity whose every
revision stays readable exactly as it was written.

**Invariants**:
- A spec's body lives in one artifact. Each spec revision pins exactly one
  artifact revision and its sha256, so storage, history, bounded reads and
  redaction are the artifact machinery's (artifacts-and-sharing.md §6–7).
- `GET /api/specs/[id]?revision=N` returns revision N's body byte for byte.
  Without it, the head.
- An unchanged body is not a new revision.
- Requirement ids (`R-n`, `AC-n`, `D-n`, `I-n`) are parsed from the body,
  first definition wins, fenced code ignored. They are not stored separately.
- A parent spec must be in the same workspace.
- `PUT /api/specs/[id]/parent { parentSpecId | null }` sets, changes or clears
  the parent in one statement that walks the new parent's ancestors and writes
  only when the spec is not among them: a parent that is the spec or one of its
  descendants is a 409 and nothing is written. Relating is structure, not body:
  the version does not move.

## 2. Drafts two writers cannot silently overwrite

**Capability statement**: A revise MUST name the version it read, and MUST land
whole or not at all.

**Invariants**:
- `PATCH /api/specs/[id] { expectedVersion, body }` is one SQL statement. The
  body artifact is updated only while it is at the revision the head pins and
  the spec at `expectedVersion`; the version bump and the new spec revision ride
  in the same statement. A stale version is a 409 `version_conflict` with
  `currentVersion`, and the loser writes nothing.
- A revision records who wrote it: `user` for a person's session, `agent` for
  an API key or task token.
- A revise always leaves the head a draft. On an approved spec it proposes
  N+1; `approved_revision` stays N (§6).

**Acceptance criteria**:
- AC-1: GIVEN two writers at version 1 WHEN both revise THEN one lands as
  revision 2 and the other gets 409 with currentVersion 2; re-reading and
  revising on top lands revision 3 (`apps/web/tests/db/specs.test.ts`).
- AC-2: GIVEN revision 2 WHEN revision 1 is read THEN its body is unchanged.

## 3. Agents over MCP

**Invariants**:
- `manage_specs` (worker level) is `create_draft`, `get`, `revise`, `list`,
  `relate`, `submit` and `approve` over the routes above, so their reach and
  approval checks apply. Reads need `tasks:read`, writes `tasks:write`.
  `submit` and `approve` from an agent run get the route's 403 back as an
  error; from a person's own OAuth session they work (§6).
- A stale `revise` comes back as an error naming `currentVersion` and the
  recovery (re-read, merge, revise on top); nothing is written.
- `get` inlines a body up to 20,000 characters, else points at the bounded
  artifact reads of its pinned revision (artifacts-and-sharing.md §7).
- No parameter sets a status; only `submit` and `approve` move it, as a person.

**Code surface**:
- `packages/core/mcp-specs.ts` — `handleSpecsAction`

## 4. Reach

**Invariants**:
- Reading needs workspace access; creating and revising need `canCreate`. A
  task token reaches only its own task's workspace. Another team reads,
  lists and revises nothing (404).

## 5. Repo-owned specs (not built)

A Living Spec will reference a repo spec as `{path, commitSha}`. Deferred to
task 496d5ef0: repo specs stay Git-canonical (D-1), so a reference is only
honest with a reader that resolves the file at that commit through the GitHub
App; storing a path and SHA with nothing to read them would claim a pin the
platform cannot show. No column exists for it yet.

## 6. Approval and pinned work

**Capability statement**: Only a person MUST be able to put a spec revision in
force, and work started on a revision MUST keep resolving that revision while
later ones are proposed (D-4).

**Invariants**:
- `POST /api/specs/[id]/submit { expectedVersion }` (draft to `in_review`) and
  `POST /api/specs/[id]/approve { revision, expectedVersion }` need a person:
  a dashboard session or the person's own OAuth session, never an API key or
  a per-task token (403). The person holds `approve_specs` (owner or admin by
  default, team-permissions.md) or is named in the workspace's
  `gitConfig.livingSpecs.approverUserIds`. A spec the caller cannot read is a
  404.
- Only the head revision is approved, from the version the person read. One
  statement stamps the revision (`approved_by`, `approved_at`, set only while
  unset) and moves `specs.approved_revision` to it, both only while the spec
  is still at that version and head; a race or a second approval writes
  nothing and is a 409 naming `currentVersion`.
- An approved revision is never mutated: its body is an artifact revision the
  artifact trigger keeps immutable, and its stamp is written once. Revising
  proposes N+1 as a draft; N stays in force until a person approves N+1.
- A task filed with `context.specSource.specId` is pinned as it is filed
  (`apps/web/src/lib/specs/pin.ts`): the server writes the approved revision's
  `specRevisionId`, `revision` and `contentHash` from the database, overwriting
  whatever the caller sent. A spec with no approved revision, a named revision
  that is not approved, or a spec in another workspace refuses the filing
  (409/409/404) and nothing is inserted. `commitSha` is kept when it is a SHA.
  A task naming no spec, or only a repo document (`specPath`), is untouched.
- `specSource` grew additively: `{specPath, planningTaskId}` (repo document,
  approvePlan) and `{specId, specRevisionId, revision, contentHash, commitSha}`
  (Living Spec pin). Children of an approved plan inherit the planning task's
  pin.
- The reviewer reads the pinned content, never the PR's copy: a Living Spec
  pin reads exactly that revision, hash-checked; a repo document pinned to
  `commitSha` is read at that commit. A spec the task names that cannot be
  read (missing, hash mismatch, fetch failure) is an explicit finding: the
  reviewer is told conformance is unverified and to escalate.

**Acceptance criteria**:
- AC-3: GIVEN revision N approved and a task filed against the spec WHEN an
  agent proposes N+1 THEN the task's pin and its review still resolve N byte
  for byte, the spec's approved revision stays N, and the agent cannot approve
  N+1; a person can (`apps/web/tests/db/spec-approval.test.ts`).
- AC-4: GIVEN an agent token, a bare API key or a plain member WHEN they
  submit or approve THEN 403 and nothing is stamped.

**Code surface**:
- `apps/web/src/lib/specs/approval.ts` — `specApprover`, `submitSpecRevision`, `approveSpecRevision`
- `apps/web/src/lib/specs/pin.ts` — `pinSpecSource`, `readPinnedSpecRevision`
- `apps/web/src/lib/reviewer.ts` — `renderSpecConformanceGuidance`

**Not yet**:
- The pin is taken when a task is filed, not when it is claimed: a task filed
  under N and claimed after N+1 is approved still runs on N, by design.
- No dashboard page lists or approves specs yet; approval is over the routes
  and `manage_specs` from a person's session. The task page shows the pinned
  revision.
- A repo document without `commitSha` (the legacy emitsPlan shape) is still
  read at the PR head.
