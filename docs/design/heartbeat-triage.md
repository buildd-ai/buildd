---
status: superseded
superseded_by: docs/design/event-driven-mission-replanning.md
superseded_on: 2026-09-28
superseded_reason: >
  Events now plan every auto mission, and the heartbeat dispatches the
  organizer only when the deterministic stuck check (isMissionStuck) holds.
  That answers this doc's question ("does this cycle need the organizer?")
  without a model call, so the triage call site was removed from the
  schedules cron and the heartbeat_triage experiment concluded. The triage
  module and its arm-resolution helpers are deleted; the experiment kind, the
  looks table and the readout stay so existing experiments remain readable.
# Structural conformance only; passing does not certify every prose invariant.
# Still present: the experiment kind's arm decision, the looks table and the
# readout. The triage look itself is deleted (see superseded_reason).
assertions:
  - id: "experiment-arm"
    type: "symbol"
    name: "decideHeartbeatTriageArm"
    path: "packages/core/heartbeat-triage-experiment.ts"
  - id: "looks-table"
    type: "symbol"
    name: "heartbeatTriageLooks"
    path: "packages/core/db/schema.ts"
  - id: "readout"
    type: "symbol"
    name: "computeHeartbeatTriageReadout"
    path: "packages/core/heartbeat-triage-readout.ts"
---

# heartbeat-triage

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/heartbeat-triage.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
