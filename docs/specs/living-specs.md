---
title: Living Specs
status: draft
owner: max
last_verified: 2026-10-12
summary: Every Living Spec revision MUST stay immutable and no writer silently overwrites another; a person approves one revision, and work reads verified only when it passes that revision on its current head.
domain: knowledge
surfaces: [apps/web/src/lib/specs/store.ts, apps/web/src/lib/specs/approval.ts, apps/web/src/lib/specs/pin.ts, apps/web/src/app/api/specs/[specId]/route.ts]
related: [artifacts-and-sharing, knowledge-ingest-pipeline]
keywords: [living spec, repo spec reference, repoRefs, read_ref, commit sha, governed outcome, verdict, verified, spec conflict, spec revision, expectedVersion, version conflict, normative, requirement id, approval, manage_specs, parent spec, pinned revision, specSource, approve_specs, recall, knowledge graph, living_spec]
verified_by: [apps/web/tests/db/specs.test.ts, apps/web/tests/db/spec-section-revise.test.ts, apps/web/tests/db/spec-repo-refs.test.ts, apps/web/src/lib/specs/repo-refs.test.ts, apps/web/src/lib/specs/repo-source.test.ts, apps/web/tests/db/spec-outcome-verification.test.ts, apps/web/src/app/api/specs/outcomes/[taskId]/route.test.ts, packages/core/__tests__/governed-outcome.test.ts, apps/web/tests/db/spec-approval.test.ts, apps/web/tests/db/spec-approval-confirm.test.ts, apps/web/src/app/api/specs/[specId]/approve/route.test.ts, apps/web/src/components/SpecApprovalRequest.dom.test.tsx, apps/web/tests/db/spec-approval-view.test.ts, apps/web/src/lib/specs/diff.test.ts, apps/web/src/lib/reviewer.test.ts, apps/web/src/lib/approve-plan.test.ts, packages/spec-contract/src/requirements.test.ts, apps/web/src/app/api/specs/[specId]/route.test.ts, apps/web/src/app/api/specs/[specId]/parent/route.test.ts, packages/core/__tests__/mcp-tools-specs.test.ts, apps/web/tests/db/spec-knowledge.test.ts, packages/core/__tests__/living-spec-knowledge.test.ts, apps/web/tests/db/spec-pages.test.ts, apps/web/src/lib/specs/page-view.test.ts, apps/web/src/components/SpecList.dom.test.tsx, apps/web/src/components/SpecPage.dom.test.tsx, apps/web/tests/db/spec-pin-at-claim.test.ts, packages/spec-contract/src/scope.test.ts, apps/web/src/components/SpecSourceBlock.test.tsx, packages/spec-contract/src/check-lines.test.ts, apps/web/src/lib/specs/approval.test.ts, packages/spec-contract/src/contract.test.ts, packages/spec-contract/src/no-buildd-imports.test.ts, packages/spec-contract/src/design.test.ts, apps/web/tests/db/spec-design.test.ts, apps/web/tests/db/spec-visual-verdict.test.ts, apps/web/src/app/api/workers/claim/visual-audit-spec-criteria.test.ts]
supersedes: []
assertions:
  - id: approve-spec-revision
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: approveSpecRevision
    path: apps/web/src/lib/specs/approval.ts
  - id: spec-patch-route
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: route
    method: PATCH
    path: "/api/specs/[specId]"
    file: apps/web/src/app/api/specs/[specId]/route.ts
  - id: spec-read-route
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: route
    method: GET
    path: "/api/specs/[specId]"
    file: apps/web/src/app/api/specs/[specId]/route.ts
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
- A revise MAY name one section instead of sending the whole body:
  `{ expectedVersion, section | heading, body }`, where `section` is an outline
  id from the bounded read views and `heading` a heading used exactly once.
  The server replaces that section's span (heading line to the next heading at
  the same or a higher level) and revises the result as a whole body, so every
  rule above applies unchanged. An unknown id, a missing or repeated heading,
  or a result over the body cap is a 400 and nothing is written.
- A spec's body artifact changes only through a revise. A generic artifact
  write (`PATCH /api/artifacts/[id]`, MCP `update_artifact`, `writeArtifactBody`)
  on it is a 409 `spec_body` naming `manage_specs revise`, title and metadata
  included, and writes nothing. Keyed upserts cannot reach it: it has no key.
- An operator redaction (`redactArtifactText`) still removes a value from a
  spec body and its history, because removing a leaked secret outranks the
  spec's history. The body then sits past the revision the head pins, so the
  next revise is a 409 `spec_body_moved` that says so, with no
  `currentVersion` to retry at; the recovery is a new spec from the current
  text.

**Acceptance criteria**:
- AC-1: GIVEN two writers at version 1 WHEN both revise THEN one lands as
  revision 2 and the other gets 409 with currentVersion 2; re-reading and
  revising on top lands revision 3 (`apps/web/tests/db/specs.test.ts`).
- AC-2: GIVEN revision 2 WHEN revision 1 is read THEN its body is unchanged.
- AC-3: GIVEN a spec at version 1 WHEN one section is revised THEN revision 2
  is the old body with only that span replaced, hash-pinned; a stale version
  is 409 and an unknown section 400, both writing nothing
  (`apps/web/tests/db/spec-section-revise.test.ts`).
- AC-4: GIVEN a spec WHEN its body artifact is written through a generic
  artifact path THEN the write is refused and nothing changes, and the spec
  still revises; GIVEN a redacted spec body WHEN it is revised THEN the 409
  names the out-of-band change (`apps/web/tests/db/spec-body-guard.test.ts`).

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

## 5. Repo-owned specs, cited at a commit

**Capability statement**: A Living Spec revision MAY cite repo-owned specs,
which stay Git-canonical (D-1), as `{ path, commitSha }`. A citation MUST keep
reading the file as it was at that commit, whatever the branch does later.

**Invariants**:
- `repoRefs` live on the spec revision (`spec_revisions.repo_refs`), so they
  are as immutable as the revision. A column, not a typed link: a link points
  an artifact at a subject, and a repo file is neither an artifact nor a
  Buildd subject, so a link would need a new subject kind plus a fake id for
  the file. The column is the smaller change.
- On write, every new reference is checked against the workspace's GitHub
  repo, the one its `github_repos` link names (never the free-text
  `workspaces.repo`): `commitSha` must be a full 40-character SHA that is a
  commit in that repo (`git/commits/<sha>`), and `path` a repo-relative file
  that exists at it. A branch name, a short SHA, an absolute path or one with
  `..` is refused. Anything that does not resolve is a 400 and nothing is
  written: no spec, no revision, no body change. At most 20 per revision.
- A revise without `repoRefs` carries the head's references forward; `[]`
  clears them. Changing only the references writes a new revision that pins
  the same body revision.
- Only a file the revision cites is readable, at the commit it cites, through
  `GET /api/specs/[specId]/repo-ref` (MCP `manage_specs action=read_ref`), in
  the bounded artifact views (`outline`, `section`, `range`, `grep`, `meta`,
  `full`). It is not a general repo reader, and reach is the spec's workspace.

**Acceptance criteria**:
- AC-8: GIVEN a revision citing path P at commit C WHEN the branch moves on
  THEN reading P still returns C's text, and a later revision citing a newer
  commit leaves the earlier one reading C (`apps/web/tests/db/spec-repo-refs.test.ts`).
- AC-9: GIVEN a path missing at C, or a commit the repo does not have, or a
  branch name WHEN a draft or revise cites it THEN 400 and nothing is written.
- AC-10: GIVEN a caller in another workspace WHEN it reads the reference THEN
  404.

**Code surface**:
- `apps/web/src/lib/specs/repo-refs.ts` — `parseRepoRefs`, `normalizeRepoPath`, `normalizeCommitSha`
- `apps/web/src/lib/specs/repo-source.ts` — `readRepoFileAtCommit`, `fetchFileAtCommit`
- `apps/web/src/lib/specs/store.ts` — `readSpecRepoRef`
- `apps/web/src/app/api/specs/[specId]/repo-ref/route.ts` — `GET`

**Not yet**:
- A repo-file read is not recorded in the artifact read ledger: that ledger
  keys on an artifact, and a cited file is not one.

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
- An approve from an OAuth bearer session (MCP or chat) approves nothing: an
  agent may be driving it. The route answers 202 with a link
  (`/app/specs/[id]/approve?request=…`) carrying a signed request for exactly
  that revision, version and body hash, valid 24 hours
  (`apps/web/src/lib/specs/approval-request.ts`). The revision is approved
  only when a person with approval rights confirms it from a dashboard session
  (`POST /api/specs/[id]/approve/confirm { request }`); any bearer is a 403.
  A spec that moved since the request is a 409 `request_stale`, an expired or
  forged request a 400, and a request already confirmed reads as done and
  writes nothing.
- The confirm page shows what the request would put in force two ways: the
  revision itself rendered as Markdown, and its changes. It opens on the
  rendered revision when the spec has no approved revision (the diff would be
  every line added), and on the changes otherwise.
- The changes come from `apps/web/src/lib/specs/diff.ts`, the same bounded
  diff `GET /api/specs/[id]/diff` returns (same sections, context and caps),
  against the approved revision. Each changed section shows its heading path
  and its lines added and removed; each line shows its number in the old and
  the new revision. Long lines wrap: nothing is cut off and the page does not
  scroll sideways, down to a 320px-wide screen. What the caps leave out is
  stated as a count.
- Switching views never changes what Confirm approves: it always sends the
  request it was opened with, for the revision that request names.
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
- Work runs on the revision approved when it starts: the task's first claim
  re-pins it to the revision approved then (`apps/web/src/lib/specs/claim-pin.ts`,
  `pinnedAt: 'claim'`, `repinnedFrom`). After that the pin never moves: a task
  a worker has run, a retry attempt, a pin taken at a claim, and a revision
  the filer named explicitly all keep theirs.
- A task names the criteria it answers for in `context.specSource.criteria`
  (`packages/spec-contract/src/scope.ts`): 1 to 50 `R-n`/`AC-n` ids of the pinned
  revision, normalized (`AC-03` is `AC-3`) and de-duplicated. An id the
  revision lacks, a decision or invariant, an empty list or a non-list is a
  400 naming the revision's criteria, and nothing is inserted. Left out, the
  task answers for every criterion. The claim re-pin moves a scoped task only
  when the new revision still has every id in its scope; otherwise the task
  keeps the revision those ids came from, and the claim log says which id is
  gone.
- `specSource` grew additively: `{specPath, planningTaskId}` (repo document,
  approvePlan) and `{specId, specRevisionId, revision, contentHash, commitSha}`
  (Living Spec pin), plus `criteria`, `pinnedAt`, `repinnedFrom` and
  `explicit`. Children of an approved plan inherit the planning task's
  pin.
- The reviewer reads the pinned content, never the PR's copy: a Living Spec
  pin reads exactly that revision, hash-checked; a repo document pinned to
  `commitSha` is read at that commit. A spec the task names that cannot be
  read (missing, hash mismatch, fetch failure) is an explicit finding: the
  reviewer is told conformance is unverified and to escalate. A scoped task's
  reviewer is told which criteria the task answers for, and that the others
  are context, not work it owes.
- The task page names the spec, links its page (§9) and shows the pinned
  revision, a newer approved revision when there is one, and the governed
  outcome (§7) of each criterion the task answers for, failures first, at
  most 8 with the rest counted (`apps/web/src/components/SpecSourceBlock.tsx`).

**Acceptance criteria**:
- AC-3: GIVEN revision N approved and a task filed against the spec WHEN an
  agent proposes N+1 THEN the task's pin and its review still resolve N byte
  for byte, the spec's approved revision stays N, and the agent cannot approve
  N+1; a person can (`apps/web/tests/db/spec-approval.test.ts`).
- AC-4: GIVEN an agent token, a bare API key or a plain member WHEN they
  submit or approve THEN 403 and nothing is stamped.
- AC-11: GIVEN a person's own OAuth session WHEN it approves THEN nothing is
  stamped and it gets a confirmation link; WHEN that person (or another owner
  or admin) confirms it from the dashboard THEN that revision is approved, and
  a revise in between makes the link stale
  (`apps/web/tests/db/spec-approval-confirm.test.ts`).
- AC-12: GIVEN a spec with no approved revision WHEN a person opens its
  confirmation link THEN the page carries the whole revision and shows it
  rendered, with every line counted as added from line 1; GIVEN an approved
  revision N and a request for N+1 THEN it opens on the changes against N
  (`apps/web/tests/db/spec-approval-view.test.ts`,
  `apps/web/src/components/SpecApprovalRequest.dom.test.tsx`).
- AC-13: GIVEN a changed, an added and a removed section WHEN the changes are
  shown THEN each section carries its +/− counts and each line its old and new
  line numbers, elided context reads exactly like the API's text diff, and the
  rows obey the same caps (`apps/web/src/lib/specs/diff.test.ts`,
  `apps/web/src/components/SpecApprovalRequest.dom.test.tsx`).
- AC-14: GIVEN a line longer than the screen WHEN it is shown in the changes
  THEN it wraps and the diff has no sideways scroll
  (`apps/web/src/components/SpecApprovalRequest.dom.test.tsx`).
- AC-15: GIVEN a person who switches between the two views WHEN they press
  Approve THEN the one request sent is the token the page was opened with,
  naming the same revision (`apps/web/src/components/SpecApprovalRequest.dom.test.tsx`).
- AC-28: GIVEN a task filed while N is approved and N+1 approved before its
  first claim WHEN it is claimed THEN it is pinned to N+1 with its hash; GIVEN
  it scoped to an id N+1 no longer has THEN it keeps N
  (`apps/web/tests/db/spec-pin-at-claim.test.ts`).
- AC-29: GIVEN a task scoped to AC-1 of a revision with R-1 and AC-1 WHEN AC-1
  passes on the current head THEN the outcome reads verified, and a verdict on
  R-1 is a 400; GIVEN a scope naming an id the revision lacks THEN the filing
  is a 400 naming the revision's criteria
  (`apps/web/tests/db/spec-outcome-verification.test.ts`,
  `packages/spec-contract/src/scope.test.ts`).
- AC-30: GIVEN a pinned task WHEN its page renders THEN it names and links
  the spec, says when a newer revision is approved, and lists each criterion
  it answers for with its verdict, failures first; a pass on an older commit
  reads as such, not as a pass (`apps/web/src/components/SpecSourceBlock.test.tsx`).

**Code surface**:
- `apps/web/src/lib/specs/approval.ts` — `specApprover`, `submitSpecRevision`, `approveSpecRevision`, `confirmSpecApproval`
- `apps/web/src/lib/specs/approval-request.ts` — `signSpecApprovalRequest`, `verifySpecApprovalRequest`
- `apps/web/src/lib/specs/pin.ts` — `pinSpecSource`, `readPinnedSpecRevision`
- `apps/web/src/lib/specs/claim-pin.ts` — `repinSpecAtClaim`
- `packages/spec-contract/src/scope.ts` — `checkCriteriaScope`, `inScope`, `scopeOf`
- `apps/web/src/lib/specs/task-view.ts` — `loadLivingSpecView`; `apps/web/src/components/SpecSourceBlock.tsx` — `SpecSourceBlock`
- `apps/web/src/lib/reviewer.ts` — `renderSpecConformanceGuidance`
- `apps/web/src/lib/specs/approval-view.ts` — `approvalRequestView`
- `apps/web/src/lib/specs/diff.ts` — `diffSpecBodies`, `diffSpecHunks`, `diffSpecRevisions`
- `apps/web/src/components/SpecApprovalRequest.tsx` — `SpecApprovalRequest`
- `apps/web/src/components/SpecDiffView.tsx` — `SpecDiffView`

**Not yet**:
- No horizontal overflow at 320px is held by the wrapping the DOM test
  asserts and was measured on screenshots at 320, 390 and 1280px; no CI test
  renders the page at a real width yet.
- A repo document without `commitSha` (the legacy emitsPlan shape) is still
  read at the PR head.

## 7. Verified outcomes

**Capability statement**: A task pinned to an approved revision MUST read
verified only when its outcome passes every criterion it answers for (§6:
its scope, else all of the revision's) on the current PR head; a violated criterion MUST read fail, and anything not
shown MUST read unverified, never pass (D-5). This is separate from whether
the task completed or its PR merged.

**Invariants**:
- The criteria are the revision's requirements and acceptance criteria: lines
  that start with `R-n` or `AC-n` (as a line, list item, heading or bold
  label, outside fenced code; first definition wins;
  `packages/spec-contract/src/requirements.ts` `specCriteria`). Decisions (`D-n`)
  and invariants (`I-n`) are context, not criteria. They are read from the
  pinned revision's body, so a later revision never changes what a running
  task is judged against, and narrowed to the task's scope when it has one; a
  verdict on a criterion outside the scope is a 400.
- A verdict is one row in `spec_outcome_verdicts`: the task, the pinned
  revision, the criterion, `pass | fail | inconclusive | unsupported` (the
  verification-check vocabulary), the PR head it judged, and its evidence:
  `[{kind, ref}]` pointers, the artifact read ids it relied on (F4 read
  ledger, same workspace only) and who recorded it. Append-only; the newest
  verdict per criterion stands. A criterion the revision lacks, a verdict
  outside the vocabulary or a missing head is a 400 and nothing is written.
- The outcome (`foldGovernedOutcome`, packages/spec-contract/src/outcome.ts, re-exported by packages/core/verification-check.ts):
  `fail` when any criterion's newest verdict is fail; `verified` only when
  every criterion's newest verdict is a pass on the head the workflow kernel
  observes for the task's PR delivery; `unverified` otherwise: a missing,
  inconclusive or unsupported verdict, a pass on an older head, no PR head,
  or no criteria.
- Advisory: no outcome blocks completing a task or merging its PR. A failed
  outcome is reported as failed beside a completed task and a merged PR.
- Who records: a person or account with write access to the workspace, or the
  per-task token of the review round the platform filed for the subject's own
  PR delivery. A task's own token reads its outcome but cannot record on it
  (403): a task never grades itself. Nor does a builder fix attempt (CI,
  conflict or review fix) or any other task filed under the subject (403).
  Another workspace can neither record nor read (404).
- The reviewer of a pinned task is given the revision's criteria and asked to
  record one verdict each at the head it reviews (`manage_specs action=verdict`).
  Its review verdict still alone decides the merge.
- A criterion with a check line under it (`check: <command>`,
  `packages/spec-contract/src/check-lines.ts`) is verified by running that
  command at the PR head (`apps/web/src/lib/specs/criterion-checks.ts`): one
  run per task, revision, criterion and head, filed as a verification task a
  runner executes. The runner's exit code is the verdict (0 pass, nonzero
  fail, a failed checkout inconclusive), recorded as `check:<task>`; an agent
  cannot write it. Only criteria in the task's scope are run. A criterion
  with no check stays graded by the reviewer or a person.
- `get_task` shows `Governed outcome` beside `Status` for a pinned task;
  `manage_specs action=outcome` lists each criterion; the task page shows it
  (§6).
- Two criteria of an approved revision that disagree are recorded as a
  `conflict` discrepancy (`POST /api/specs/[id]/conflicts`,
  `manage_specs action=conflict`): `spec_discrepancies` with
  `spec_revision_id` set, `spec_path = living-spec:<specId>`, one row per
  pair. Advisory: a person accepts it; it is never promoted or flipped, and a
  repo-doc ledger run never resolves it.

**Acceptance criteria**:
- AC-5: GIVEN an approved R-1 and a completed task with a merged PR WHEN its
  reviewer records R-1 fail THEN the outcome reads fail while the task stays
  completed and the PR merged; WHEN the fix lands on a new head and every
  criterion passes there THEN it reads verified, and a pass on the older head
  alone reads unverified (`apps/web/tests/db/spec-outcome-verification.test.ts`).
- AC-6: GIVEN no verdict, or an inconclusive or unsupported one WHEN the
  outcome is read THEN it is unverified, never verified.
- AC-7: GIVEN a caller in another workspace WHEN it records or reads a
  verdict THEN 404 and nothing is written.

**Code surface**:
- `apps/web/src/lib/specs/outcome.ts` — `recordSpecVerdict`, `readGovernedOutcome`, `recordSpecConflict`
- `apps/web/src/lib/specs/criterion-checks.ts` — `dispatchCriterionChecks`, `handleCriterionCheckOutcome`; `packages/spec-contract/src/check-lines.ts` — `criterionChecks`
- `apps/web/src/app/api/specs/outcomes/[taskId]/route.ts` — `GET`, `POST`
- `apps/web/src/app/api/specs/[specId]/conflicts/route.ts` — `POST`
- `packages/spec-contract/src/outcome.ts` — `foldGovernedOutcome`

**Not yet**:
- A criterion with no check line is graded by the reviewer's judgement, with
  no fixed rubric beyond the verdict vocabulary.
- Nothing reads a spec's conformance across all its tasks, and no mission
  goal criterion names a spec's criteria.

## 8. Approved specs in knowledge

**Capability statement**: A spec's approved revision MUST be findable through
recall, and its explicit references MUST be walkable in the knowledge graph,
without an approval ever depending on either.

**Invariants**:
- Only the approved revision is indexed. When a person's approval commits
  (`approveSpecRevision`, which the confirmation link also goes through), it
  emits the core event `spec.approved` and the knowledge module indexes it: that
  revision's body, exactly the artifact revision it pins, is chunked with the
  docs markdown chunker into the workspace's `spec` corpus
  (`{workspaceId}:spec`). Drafts and proposed revisions are never indexed: a
  revise on an approved spec leaves the approved text in recall until N+1 is
  approved.
- One approved text per spec. Every chunk id starts with
  `living-spec:<specId>#`, and an approval first deletes every chunk under that
  prefix, so re-approval replaces the earlier text instead of adding a second.
  Chunks carry `specId`, `revision`, `contentHash`, `parentSpecId`, `scope`,
  `workspaceId` and `approvedAt`, source type `living_spec`, and no source
  path: the repo ingest prunes paths it did not see on disk, and these are not
  repo files. Their source URL is the spec page, `/app/specs/<specId>` (§9),
  so a recall hit opens the spec, not an approval.
- The graph comes only from what the spec stores: the spec `part_of` its
  parent spec; the approved revision `references_doc` each repo file it cites
  (the same `file` entity, keyed by repo path, that the repo ingest makes; the
  commit sits on the revision entity's `repoRefs`); and the revision
  `supersedes` the revision approved before it. No inferred, similarity or
  agent-supplied edge is written for a spec. Each approval deletes this spec's
  `living_spec:` edges and chunk links and writes them again, so the graph can
  be rebuilt at any time.
- Fail-open, and off the response. Indexing runs after the approval has
  committed and after the approve response is sent (`after()`), so a person
  never waits on chunking, embedding or graph writes; recall picks the text up
  a moment later. A failure is logged and never fails or rolls back the
  approval. Re-running the backfill
  (`bun run --cwd apps/web specs:backfill-knowledge --apply`) repairs it and is
  idempotent.

**Acceptance criteria**:
- AC-17: GIVEN a draft WHEN nothing is approved THEN it has no chunks; WHEN a
  person approves it THEN its chunks carry the approved revision's hash and a
  lexical recall finds them (`apps/web/tests/db/spec-knowledge.test.ts`).
- AC-18: GIVEN an approved spec WHEN it is revised THEN recall still holds only
  the approved text; WHEN N+1 is approved THEN its text replaces N's
  (`apps/web/tests/db/spec-knowledge.test.ts`).
- AC-19: GIVEN a spec with a parent and two repo refs WHEN approved THEN exactly
  one `part_of` and two `references_doc` edges exist; WHEN re-approved with one
  ref removed THEN that edge is gone and `supersedes` points at the previous
  approval (`apps/web/tests/db/spec-knowledge.test.ts`,
  `packages/core/__tests__/living-spec-knowledge.test.ts`).
- AC-20: GIVEN the store and the graph writer both throw WHEN a person approves
  THEN the spec is approved (`apps/web/tests/db/spec-knowledge.test.ts`).
- AC-31: GIVEN a person approves WHEN the approve response returns THEN the
  approval has committed and the index is scheduled for after the response,
  not run; the access and approver checks go out together, and so do the two
  reads after the approval (`apps/web/src/lib/specs/approval.test.ts`,
  `apps/web/tests/db/spec-knowledge.test.ts`).

**Code surface**:
- `apps/web/src/lib/specs/approval.ts` — emits `spec.approved` after the approval commits, after the response (`specApprovalDeps`)
- `apps/web/src/lib/knowledge-subscribers.ts` — `living-spec-index` subscriber
- `apps/web/src/lib/specs/knowledge.ts` — `indexApprovedSpec`, `specKnowledgeDeps`
- `packages/core/knowledge-store/living-spec.ts` — `buildLivingSpecChunks`, `buildLivingSpecGraph`
- `packages/core/knowledge-store/living-spec-graph.ts` — `replaceLivingSpecGraph`
- `apps/web/scripts/backfill-living-spec-knowledge.ts`

**Not yet**:
- Nothing retires or deletes a spec yet (`retired` and `superseded` are only
  read). When that lands, it must remove the spec's chunks and edges too.

## 9. Reading specs in the dashboard

**Capability statement**: A person MUST be able to find every spec of a
workspace they can read, read the revision in force, see what is waiting for
approval and what each revision changed, and approve the waiting one from the
same page, without an agent in between.

**Invariants**:
- The list is per workspace, at `/app/workspaces/[id]/specs`, linked from the
  workspace page beside Memory, Schedules and Artifacts. It is not a primary
  nav item: the primary surfaces each answer one question
  (surface-ia-home-missions-initiatives.md) and a spec belongs to one
  workspace, like the workspace's memory and schedules.
- Who can see a spec on any of these pages is exactly who can read it over
  `GET /api/specs/[id]` from a dashboard session (`reach`, §4): another
  team's workspace or spec is a 404 and its title never appears.
- The list shows specs as a tree: a spec with a parent in the same workspace
  sits under it; a spec whose parent is not in the list sits at the top. Each
  row says in words its title, scope, where it stands ("approved at revision
  N", "draft, never approved", "retired", "superseded"), "revision M waiting
  for approval" when the head is newer than the approved revision, and when it
  last changed. A workspace with no specs says how specs get made (an agent
  over MCP, or chat) and shows no counts.
- The spec page `/app/specs/[specId]` reads the approved revision by default,
  the head when nothing is approved, or `?revision=N`. One line names the
  revision being read and, when the head is newer than the approved
  revision, that revision M is waiting for approval. The body is that
  revision's text exactly, rendered as Markdown with images shown as links.
  It comes after the related specs and the revision history, so a long spec
  never pushes them out of reach.
- The page lists every revision, newest first: its number, whether a person
  or an agent wrote it, its change summary, and who approved it and when, or
  nothing when it was never approved.
- Picking two revisions shows the changes between them with `SpecDiffView`,
  from `diffSpecRevisions` (`apps/web/src/lib/specs/diff.ts`): the same
  bounded diff the API returns, and both reads are recorded in the read
  ledger like any other diff. The rendered body is read with `getSpec`, the
  same read `GET /api/specs/[id]` serves.
- A recall hit on an approved spec links here (§8: the chunk's source URL
  is `/app/specs/<specId>`).
- The page links to the parent spec and to each child spec in the same
  workspace. Each repo reference of the revision being read shows as
  `path @ <12-character sha>`, linking to that file at that commit on GitHub
  in the workspace's linked repo (`github_repos`, never the free-text
  `workspaces.repo`); with no linked repo it is plain text.
- When the head is not approved, the spec is neither retired nor superseded,
  and the reader may approve it (§6: `specApprover`), the page offers to
  review revision M. Reviewing shows the changes from the approved revision
  to M (or M rendered when nothing is approved), with one Approve action that
  sends `POST /api/specs/[id]/approve { revision: M, expectedVersion }` for the
  version the page was rendered at. That route, its one-statement approval and
  its 409 on a moved spec are §6's; this page adds no approval path. A reader
  who may not approve sees no approve action.

**Acceptance criteria**:
- AC-21: GIVEN a workspace whose specs include a parent with one child and a
  spec with an approved revision and a newer draft WHEN its list renders THEN
  the child sits under its parent, and the rows read "approved at revision N",
  "draft, never approved" and "revision M waiting for approval"
  (`apps/web/src/lib/specs/page-view.test.ts`,
  `apps/web/src/components/SpecList.dom.test.tsx`).
- AC-22: GIVEN a workspace with no specs WHEN its list renders THEN it says
  how specs are made and shows no count (`apps/web/src/components/SpecList.dom.test.tsx`).
- AC-23: GIVEN a person of another team WHEN they open a workspace's spec
  list or one of its specs THEN nothing about the spec is returned
  (`apps/web/tests/db/spec-pages.test.ts`).
- AC-24: GIVEN revision 1 approved and revision 2 a draft WHEN the spec page
  opens with no revision named THEN it reads revision 1 rendered and says
  revision 2 is waiting for approval; WHEN `?revision=2` THEN it reads revision
  2 (`apps/web/tests/db/spec-pages.test.ts`, `apps/web/src/components/SpecPage.dom.test.tsx`).
- AC-25: GIVEN two revisions picked WHEN the page shows their changes THEN
  the rows are the ones `diffSpecRevisions` returns for that pair
  (`apps/web/tests/db/spec-pages.test.ts`).
- AC-26: GIVEN a revision citing `docs/specs/x.md` at a commit in a workspace
  with a linked repo WHEN the page renders THEN the reference links to that
  file at that commit (`apps/web/src/lib/specs/page-view.test.ts`).
- AC-27: GIVEN an approver reviewing waiting revision M WHEN they press
  Approve THEN exactly one `POST /api/specs/[id]/approve` is sent naming M and
  the version the page was rendered at; GIVEN a reader who may not approve
  THEN no approve action renders (`apps/web/src/components/SpecPage.dom.test.tsx`,
  `apps/web/tests/db/spec-pages.test.ts`).
- AC-32: GIVEN an approver presses Approve WHEN the request is still out THEN
  the page already reads "Approved. Revision M is in force." with no action;
  WHEN it fails THEN the action returns with the error beside it; WHEN the spec
  moved (409) THEN the notice stays and no action is offered
  (`apps/web/src/components/SpecPage.dom.test.tsx`,
  `apps/web/src/components/SpecApprovalRequest.dom.test.tsx`).

**Code surface**:
- `apps/web/src/lib/specs/page-view.ts` — `specListView`, `specPageView`, `specTree`, `specStanding`, `repoRefHref`
- `apps/web/src/app/app/(protected)/workspaces/[id]/specs/page.tsx` — the list
- `apps/web/src/app/app/(protected)/specs/[specId]/page.tsx` — the spec page
- `apps/web/src/components/SpecList.tsx` — `SpecList`
- `apps/web/src/components/SpecPage.tsx` — `SpecPage`, `readingLine`
- `apps/web/src/components/useOptimisticApprove.ts` — `useOptimisticApprove`
- `apps/web/src/components/SpecRevisionPanes.tsx` — `SpecRevisionPanes` (the Spec / Changes switch, shared with the confirm page)
- `apps/web/src/lib/specs/repo-source.ts` — `linkedRepoFullName`

**Not yet**:
- Reading the rendered body is not recorded in the read ledger, matching
  `GET /api/specs/[id]`, which does not record either; diffs are recorded.
- There is no list across a team's workspaces; each workspace has its own.

## 10. Portable contract

**Capability statement**: The shapes and rules another product needs to keep
Living Specs, pin work to them and grade work against them MUST live in one
package that imports nothing of buildd's, and buildd MUST read those rules
from that package, so a copy is the same rule and not a port of it.

**Invariants**:
- `@buildd/spec-contract` (`packages/spec-contract`) holds the pure rules:
  criterion ids (`requirementIds`, `specCriteria`), check lines
  (`criterionChecks`, `checkVerdict`), scope (`checkCriteriaScope`, `inScope`),
  the verdict vocabulary (`VERDICTS`: pass, fail, inconclusive, unsupported)
  and the outcome fold (`foldGovernedOutcome`), and the content hash
  (`contentHash`, `normalizeFrozenCopy`, `frozenCopyHash`). buildd's spec
  routes, reviewer, pins and outcome import them from there;
  `packages/core/verification-check.ts` re-exports the vocabulary and the fold
  for the other verification flavors.
- It imports no buildd workspace package, database driver, app alias or path
  outside itself, and declares no dependency. A test scans every tracked file
  in it and proves its pattern can fail.
- The records, each keyed on a spec revision (an approval is a property of a
  revision, not a separate id):
  - spec source `{ kind: buildd | confluence | git, ref, version }`: where one
    version of the text lives. One home per spec; nothing syncs between homes.
  - design reference `{ kind: artifact | url | figma, ref, version, screens? }`:
    the design a revision is built to. A design stored as an artifact (an HTML
    or code prototype, or images) is versioned by its artifact revisions.
  - approval record `{ specId, revision, source, contentHash, design?,
    approvedBy, approvedAt }`, written once, by a person (§6).
  - pin `{ specId, specRevisionId, revision, contentHash, criteria? }`, written
    by the server when work is filed and re-taken at first claim (§6).
  - verdict `{ taskId, specRevisionId, criterionId, verdict, headSha,
    evidence: [{ kind, ref }], checker }`, append-only; the newest per
    criterion stands, whichever checker wrote it (§7).
- A spec home implements four operations (`SpecSourceAdapter`): read one
  version, list versions, propose a change beside the spec (never over
  approved text), and list versions newer than one it has seen. The frozen
  copy is Markdown. A home that re-serializes on save is hashed after
  `normalizeFrozenCopy`, so a save that changed nothing is not a new version;
  buildd's own home hashes its text as stored.
- Who plays each part is the host's choice. In buildd: the spec service is
  `apps/web/src/lib/specs/`, the pin reader is the claim route and the
  reviewer, the code grader is the PR reviewer's round, and check lines run
  on a runner. A copier maps the same parts to its own services; the package
  does not name them.

**Acceptance criteria**:
- AC-33: GIVEN the package alone WHEN its tests run in their own process THEN
  parsing, scope, the fold and hashing work end to end, and a home can be
  implemented against the interface with no host
  (`packages/spec-contract/src/contract.test.ts`).
- AC-34: GIVEN a file in the package that imports `@buildd/core`, a database
  driver, an app alias or a path outside the package WHEN the boundary test
  runs THEN it fails; the test first proves its pattern matches each of those
  (`packages/spec-contract/src/no-buildd-imports.test.ts`).

**Code surface**:
- `packages/spec-contract/src/index.ts` — the entry point
- `packages/spec-contract/src/outcome.ts` — `VERDICTS`, `foldGovernedOutcome`
- `packages/spec-contract/src/hash.ts` — `contentHash`, `normalizeFrozenCopy`, `frozenCopyHash`
- `packages/spec-contract/src/shapes.ts` — `SpecSource`, `DesignRef`, `ApprovalRecord`, `SpecPin`, `SpecVerdict`
- `packages/spec-contract/src/source.ts` — `SpecSourceAdapter`

**Not yet**:
- Only buildd's own home exists. A git home reads through `read_ref` (§5)
  but is not wrapped as an adapter; a wiki home is not built.
- The stored verdict row has no `checker` column: the checker is implied by
  who recorded it.

## 11. The visual audit grades spec criteria

**Capability statement**: A mission's visual audit MUST grade the spec
criteria of the tasks it reviews that a page can show, with its own
screenshots as evidence, bound to each task's PR head only when the commit it
captured contains that head; no task MAY grade its own work this way.

**Invariants**:
- At claim, a `[surface audit]` gets a "Spec criteria to judge" block: for
  each task it depends on that is pinned to a Living Spec, the task, the spec
  title and pinned revision, and the criteria that task answers for (its
  scope, §6) with their text. Computed from the audit's current dependencies,
  like its required routes. A read that fails attaches nothing.
- The audit records through `POST /api/specs/outcomes/[taskId]` with
  `checker: 'visual'` (MCP `manage_specs action=verdict checker=visual`):
  `{ criterionId, verdict, capturedSha, screenshotIds, observed }`. It lands in
  the same verdict log as the reviewer's and check runs' (§7), authored
  `visual:<audit task id>`; the newest verdict per criterion stands.
- Only the audit's own run records (its per-task token), and only when the
  audit is a visual-auditor `[surface audit]` that no agent filed (the
  platform or a person did), in the subject's mission and workspace, with the
  subject among its dependencies, and is neither the subject nor filed under
  it. Anything else is a 403 and nothing is written.
- `pass` and `fail` cite 1 to 4 screenshots that a worker of this audit
  uploaded through upload-url; `inconclusive` says what could not be seen;
  `unsupported` is refused, because the audit records only criteria it
  looked at and its verdict would replace the reviewer's.
- The audit captures the mission's capture ref, not the PR head. The server
  reads the subject's PR head from the kernel and checks on GitHub that the
  captured commit contains it: contained, the verdict binds to the PR head and
  keeps the captured commit as evidence; not contained, a 409; unreadable, a
  502; no PR head or no linked repo, a 409. Nothing is written on a refusal.
- Each cited screenshot is copied out of the audit-shot area, which expires
  after 30 days, into the artifact area before the verdict is written, and the
  verdict records the copy and `retainUntil` (400 days on). A copy that fails
  writes nothing.

**Acceptance criteria**:
- AC-35: GIVEN a builder task in a mission pinned to a spec scoped to AC-1 and
  AC-2 WHEN its audit claims THEN the block lists AC-1 and AC-2 with their text
  and the revision (`apps/web/tests/db/spec-visual-verdict.test.ts`,
  `apps/web/src/app/api/workers/claim/visual-audit-spec-criteria.test.ts`).
- AC-36: GIVEN the audit's own screenshot and a captured commit containing the
  builder's PR head WHEN it records a pass on AC-1 THEN the verdict binds to the
  PR head, cites the screenshot, its retained copy and the captured commit,
  and the builder's outcome shows it (`apps/web/tests/db/spec-visual-verdict.test.ts`).
- AC-37: GIVEN the builder, a fix attempt filed under it, an agent-filed
  audit, an audit in another mission, or a person's session WHEN each records
  a visual verdict THEN each is refused and nothing is written
  (`apps/web/tests/db/spec-visual-verdict.test.ts`).
- AC-38: GIVEN a pass with no screenshot, with another worker's screenshot, an
  `unsupported`, or an `inconclusive` without `observed` WHEN recorded THEN each
  is a 400 (`apps/web/tests/db/spec-visual-verdict.test.ts`).
- AC-39: GIVEN a captured commit that does not contain the PR head WHEN
  recorded THEN 409 and no row; GIVEN GitHub unreachable THEN 502 and no row
  (`apps/web/tests/db/spec-visual-verdict.test.ts`).

**Code surface**:
- `apps/web/src/lib/visual-audit-spec-verdict.ts` — `recordVisualVerdict`, `auditorRefusal`
- `apps/web/src/lib/specs/outcome.ts` — `recordAuditedVerdict`
- `apps/web/src/app/api/workers/claim/visual-audit-spec-criteria.ts` — `attachVisualAuditSpecCriteria`, `renderVisualAuditSpecCriteria`, `loadVisualAuditSpecCriteria`

**Not yet**:
- Nothing deletes a retained screenshot after `retainUntil`, so verdict
  evidence is kept indefinitely today; 400 days is the floor, not a ceiling.
- The task page lists each criterion's standing but does not link a visual
  verdict's screenshots.
- A mission with no `[surface audit]` (no UI change, or opted out) gets no
  visual verdicts.

## 12. Designs

**Capability statement**: A spec revision MUST be able to name the design it
is built to, at one version, so approving the revision records the design
version next to the text, the spec says when the design moved on since, and
the visual audit judges the build against that version of the design.

**Invariants**:
- A revision's `design` is `{ kind, ref, version, screens? }`
  (`parseDesignRef`, packages/spec-contract/src/design.ts), written on
  create_draft or revise (`apps/web/src/lib/specs/design.ts`):
  - `artifact` (the default): an artifact in the spec's workspace, such as an
    HTML or code prototype or images. Pinned to its current revision unless
    `version` names one, which must exist. One in another workspace is a 400.
  - `url` (https) or `figma`: `version` is required; buildd stores it as given
    and cannot tell when either moves on.
  - `screens` (at most 50) name the screens a criterion may cover.
- On revise an omitted `design` carries the head's forward and `null` clears
  it. A revise that changes only the design writes a new revision on the same
  body, which an approver approves like any other.
- Approval is of the revision, so it records the design version the revision
  carries; nothing moves it after. Reading the approved revision, the spec
  page names the design and its version, and, for an artifact design whose
  current revision is newer, says "The design changed since approval".
- A criterion names the screens it covers on a line under it:
  `screen: <id>, <id>` (`criterionScreens`, same placement rule as check
  lines, §7).
- A visual audit's claim block (§11) names the design, its version, how to
  open it (`get_artifact { artifactId, revision }` for an artifact) and each
  criterion's screens. A visual pass or fail on a criterion that names screens
  must also cite 1 or 2 screenshots of the design rendered at the same state
  (`designShotIds`), taken by the audit's own run; the verdict's evidence then
  names the design version it was judged against. A pixel difference alone is
  not a fail; the audit judges layout, content and states.

**Acceptance criteria**:
- AC-40: GIVEN an artifact design with no version WHEN a draft is created THEN
  the revision pins the artifact's current revision; GIVEN an artifact in
  another workspace, a missing revision, or a URL with no version THEN 400
  and nothing is written (`apps/web/tests/db/spec-design.test.ts`).
- AC-41: GIVEN a revise that changes only the design THEN it is a new revision
  on the same body; GIVEN a later revise that omits it THEN the design carries
  forward; GIVEN `design: null` THEN it is cleared
  (`apps/web/tests/db/spec-design.test.ts`).
- AC-42: GIVEN an approved revision with an artifact design WHEN the artifact
  is revised THEN the spec page says the design changed since approval and
  names both versions, and the approved revision still names its own
  (`apps/web/tests/db/spec-design.test.ts`,
  `apps/web/src/components/SpecPage.dom.test.tsx`).
- AC-43: GIVEN a criterion with a `screen:` line WHEN the audit records a pass
  with no design shot THEN 400; WITH one THEN the verdict cites it and the
  design version (`apps/web/tests/db/spec-visual-verdict.test.ts`).

**Code surface**:
- `packages/spec-contract/src/design.ts` — `parseDesignRef`, `designDrift`, `sameDesign`
- `packages/spec-contract/src/check-lines.ts` — `criterionScreens`, `criterionLines`
- `apps/web/src/lib/specs/design.ts` — `resolveDesign`, `approvedDesignDrift`
- `apps/web/src/lib/specs/page-view.ts` — `specPageView` (`design`)

**Not yet**:
- A URL or design-tool design cannot be checked for drift; only artifact
  designs say "changed since approval".
- The spec page does not render the design inline; it links to it.
- No design-tool integration (such as Figma) is built: such a reference is
  stored as given.

