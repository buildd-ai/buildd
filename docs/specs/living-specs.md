---
title: Living Specs
status: draft
owner: max
last_verified: 2026-10-10
summary: A Living Spec MUST keep every revision immutable and readable as written, and two writers revising one draft MUST NOT silently overwrite each other; approval is a person's act on one revision.
domain: knowledge
surfaces: [apps/web/src/lib/specs/store.ts, apps/web/src/lib/specs/requirements.ts, apps/web/src/app/api/specs/route.ts, apps/web/src/app/api/specs/[specId]/route.ts]
related: [artifacts-and-sharing]
keywords: [living spec, spec revision, expectedVersion, version conflict, normative, requirement id, approval]
verified_by: [apps/web/tests/db/specs.test.ts, apps/web/src/lib/specs/requirements.test.ts, apps/web/src/app/api/specs/[specId]/route.test.ts]
supersedes: []
---
# Living Specs

Governed intent, database-canonical for specs created through Buildd (decision
D-1; repo-owned `docs/specs` stay Git-canonical and are referenced at a commit).
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

**Acceptance criteria**:
- AC-1: GIVEN two writers at version 1 WHEN both revise THEN one lands as
  revision 2 and the other gets 409 with currentVersion 2; re-reading and
  revising on top lands revision 3 (`apps/web/tests/db/specs.test.ts`).
- AC-2: GIVEN revision 2 WHEN revision 1 is read THEN its body is unchanged.

## 3. Reach

**Invariants**:
- Reading needs workspace access; creating and revising need `canCreate`. A
  task token reaches only its own task's workspace. Another team reads,
  lists and revises nothing (404).

## 4. Approval (not built: G2)

Approving a revision is a person's act (owner or admin, or a delegated
approver), never an agent's or a timer's (D-4). An approved revision is never
mutated; running work stays pinned to it while N+1 is proposed.
`spec_revisions.approved_by/approved_at` exist for it and are unset by
everything in this spec.
