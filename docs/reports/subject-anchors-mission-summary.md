# Subject Anchors Mission Summary

**Mission:** Task subject anchors: dedupe, liveness, and dead-PR shutdown
**Verified against:** `origin/dev` at `104a3846` on 2026-07-30
**Outcome:** Complete

## Executive summary

The mission introduced a normalized subject identity for tasks and then used it
across intake, observation, claim eligibility, reconciliation, and worker
context. Tasks can now identify the pull request, error, branch, or mission
they act on independently from the PR they eventually produce.

The shipped path is deliberately conservative:

- extraction rejects conflicting high-confidence identities;
- deduplication has an explicit `file anyway` escape hatch;
- uncertain historic prose is report-only;
- PR liveness is checked before a worker can claim stale work;
- automatic closure of buildd-owned superseded PRs is opt-in and defaults off;
- workers receive bounded prior work from sibling tasks by default.

The aggregation input listed tasks 5/7, 6/7, and 7/7 as cancelled duplicates.
Those task states do not represent missing functionality: their implementation
is present on `origin/dev`, including PRs #1506, #1507, and #1516.

## Delivered phases

| Phase | Delivery | Result |
| --- | --- | --- |
| Specification | PR #1473 | Defined subject identity, extraction precedence, dedupe scopes, liveness, reconciliation, policy defaults, and rollout invariants. |
| 1/7 — schema | PR #1480 | Added the normalized task subject fields, reports and claims tables, indexes, relations, migrations, and shared types. |
| 2/7 — extraction | PR #1483 | Added pure subject extraction and normalization with conservative conflict handling and legacy-context compatibility. |
| 3/7 — observe mode | PR #1485 | Added report-only matching, telemetry, and conservative backfill before enforcement. |
| 4/7 — atomic intake | PR #1491 / v0.155 integration | Added reservation-based subject claims so concurrent task intake resolves to one canonical task without interactive transactions. |
| 5/7 — liveness | PR #1506 | Added reconciliation sweeps plus SQL and in-loop `subjectStillLive()` claim gates. |
| 6/7 — dead-PR shutdown | PR #1507 | Added ownership-verified closure of superseded buildd PRs behind `autoCloseBuilddSupersededPrs`, defaulting to `false`. |
| 7/7 — recall and controls | PR #1516 | Added subject-related prior-work injection at claim and workspace policy controls in the UI/config API. |

## End-to-end behavior

1. Task intake extracts a stable subject anchor from trusted context, explicit
   API input, or conservative prose.
2. Indexed projections and subject claims support fast matching and serialize
   concurrent intake around a canonical task.
3. Observation and reports preserve why work matched without manufacturing
   duplicate task prose.
4. GitHub lifecycle updates and reconciliation persist whether the subject PR
   remains actionable.
5. The claim route filters stale subjects in SQL and checks again in-loop as
   defense in depth.
6. When explicitly enabled, dead-PR shutdown only closes superseded PRs whose
   buildd ownership is verified.
7. A claiming worker receives bounded prior results from related tasks, while
   operators can independently disable prior-work injection or enable
   buildd-owned PR auto-close.

## Safety defaults and operational controls

- `priorWorkInjection: true`
- `autoCloseBuilddSupersededPrs: false`
- Historic or ambiguous prose remains non-destructive until confirmed.
- Pull-request lineage and PR-generation identity remain distinct, preventing
  a new failing head from being collapsed into an old result.
- Subject anchors identify the work target; worker output PR fields remain
  separate.

## Verification

Repository inspection confirmed all mission surfaces on `origin/dev`:

- `apps/web/src/lib/subject-intake.ts` and
  `apps/web/src/lib/subject-intake-db.ts`
- `apps/web/src/lib/subject-anchor-observer.ts`
- `apps/web/src/lib/subject-sweep.ts`
- `apps/web/src/app/api/workers/claim/subject-gate.ts`
- `apps/web/src/lib/dead-pr-shutdown.ts`
- `apps/web/src/app/api/workers/claim/subject-prior-work.ts`
- `apps/web/src/app/app/(protected)/workspaces/[id]/config/SubjectPolicySection.tsx`
- `packages/core/subject-anchor-extractor.ts`
- `packages/core/subject-anchor-observe.ts`
- `packages/core/db/schema.ts`

Fresh focused tests for the final three phases passed:

```text
bun test apps/web/src/app/api/workers/claim/subject-gate.test.ts
bun test apps/web/src/lib/subject-sweep.test.ts
bun test apps/web/src/lib/dead-pr-shutdown.test.ts
bun test apps/web/src/app/api/workers/claim/subject-prior-work.test.ts
```

## Follow-up posture

No implementation gap remains for this mission. Enabling
`autoCloseBuilddSupersededPrs` should remain a per-workspace operational
decision after observing report-only and reconciliation data. This report is a
rebuildable mission close-out; the design and code remain the sources of truth.
