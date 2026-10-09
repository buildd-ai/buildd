---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "question-check-route"
    type: "route"
    method: "POST"
    path: "/api/workers/[id]/question-check"
    file: "apps/web/src/app/api/workers/[id]/question-check/route.ts"
  - id: "hard-rail-detection"
    type: "symbol"
    name: "detectHardRail"
    path: "packages/core/question-gate.ts"
  - id: "workspace-kill-switch"
    type: "config_key"
    key: "jevQuestionGate"
    file: "packages/core/db/schema.ts"
  # A hold parks without a notification (the park path resolves it), and a
  # sweep surfaces it at its deadline (lib/question-hold.ts). The park path
  # stamps every park's disposition (lib/park-disposition.ts), which resolves
  # the hold.
  - id: "park-disposition-read-by-park-path"
    type: "symbol_reachable"
    symbol: "disposeParkedWaitingFor"
    entry: "apps/web/src/app/api/workers/[id]/route.ts"
    as: "read"
  - id: "hold-resurface-read-by-park-path"
    type: "symbol_reachable"
    symbol: "resolveHold"
    entry: "apps/web/src/lib/park-disposition.ts"
    as: "read"
  - id: "hold-resurface-sweep"
    type: "symbol_reachable"
    symbol: "resurfaceHeldQuestions"
    entry: "apps/web/src/app/api/cron/notify-away/route.ts"
    as: "read"
  # Weekly review loop: the reviewer schedule's tasks read the ledger of the
  # reviewed workspace only through an explicit schedule delegation, and a
  # failed read is surfaced as a status, never as zero rows.
  - id: "review-loop-delegated-read"
    type: "symbol_reachable"
    symbol: "taskScopeAllowsDelegated"
    entry: "apps/web/src/app/api/decisions/route.ts"
    as: "read"
  - id: "review-loop-strict-ledger-read"
    type: "symbol"
    name: "readDecisionLedgerPage"
    path: "packages/core/decision-ledger.ts"
---

# human-question-gate

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/human-question-gate.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
