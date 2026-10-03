---
status: partially
# Draft assertions — Tier 3 weekly cron (docs/design/spec-conformance.md §Tier 3).
# The registry this doc proposes now exists in a first, narrower form: the
# `experiments` table plus `experiment_assignments` (packages/core/db/schema.ts),
# built for the model-routing experiment (docs/design/model-routing-experiment.md),
# since extended with real CRUD, a write-boundary state machine, a readout
# engine and an MCP action (see the "Update, CRUD + readout + dashboard" note
# below). What it does NOT yet have is most of what this doc is about — the
# declared/enrolling/frozen/retired lifecycle with write-boundary preconditions
# (§1), the code-side policy-module registration and surface-fingerprint pin
# guard (§4), and non-date stopping rules (§3). Hence `partially`, not
# `implemented`. All four assertions below stay suppressed: they pass, but
# they certify pre-existing or reused infrastructure rather than this doc's
# remaining deliverables, and unsuppressing any of them would read as
# `implemented` while §1/§3/§4 are unbuilt. `experiment-registry-table`
# previously tracked real remaining progress (it failed until the `experiments`
# table shipped) — now that the table is a permanent fixture, it will pass
# forever regardless of whether the lifecycle/pin/stopping-rule work ever
# lands, the same perpetual-pass trap the other three were suppressed for at
# registry-v1 time. No successor deliverable in §1/§3/§4 has a committed
# symbol name yet to point a replacement assertion at, so this is suppressed
# rather than corrected; the doc should gain a fresh, unsuppressed assertion
# once one of those sections has a concrete implementation to name.
assertions:
  - id: "experiment-registry-table"
    type: "symbol"
    name: "experiments"
    path: "packages/core/db/schema.ts"
    skip_until: "2026-12-19"
    skip_reason: "The `experiments` table genuinely shipped (registry v1, for model-routing) and is this doc's own proposed deliverable — not a false positive — but it is a bare table, not the declared/enrolling/frozen/retired lifecycle (§1), the surface-fingerprint pin guard (§4), or the non-date stopping rules (§3) that keep this doc at `partially`. Unsuppressed, it passes forever once shipped regardless of whether that remaining work ever lands."
  - id: "arm-assignment-randomizer"
    type: "symbol"
    name: "hashUnitInterval"
    path: "packages/core/experiment-randomizer.ts"
    skip_until: "2026-12-19"
    skip_reason: "hashUnitInterval genuinely shipped (extracted from the memory-digest arm ahead of the registry) — not a false positive — but it is pre-existing infrastructure this doc reuses, not one of its remaining deliverables (lifecycle states, pin manifest, stopping rules). Unsuppressed, it would make the doc read as implemented while those are unbuilt."
  - id: "cbm-readout-aggregation"
    type: "symbol"
    name: "aggregateCbm"
    path: "apps/web/src/lib/cbm-insight.ts"
    skip_until: "2026-12-19"
    skip_reason: "aggregateCbm genuinely shipped (existing CBM readout this proposal reuses) — not a false positive — but it is pre-existing infrastructure, not one of this doc's remaining deliverables (lifecycle states, pin manifest, stopping rules). Unsuppressed, it would make the doc read as implemented while those are unbuilt."
  - id: "experiment-cleanup-task-precedent"
    type: "symbol"
    name: "fileExperimentCleanupTask"
    path: "apps/web/src/lib/experiment-cleanup-task.ts"
    skip_until: "2026-12-19"
    skip_reason: "fileExperimentCleanupTask genuinely shipped (the retirement-cleanup precedent this proposal's §1 generalises) — not a false positive — but it is pre-existing infrastructure, not one of this doc's remaining deliverables (lifecycle states, pin manifest, stopping rules). Unsuppressed, it would make the doc read as implemented while those are unbuilt."
---

# experiment-lifecycle

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/experiment-lifecycle.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
