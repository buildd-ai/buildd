---
status: implemented
# Promoted from `proposed` — the human-editorial call the prior drafting pass
# deliberately deferred (see git history for that suppression comment). All
# four assertions below pass against the current tree: Proposal §1
# (emitsPlan), §2 (forced requiresPlanApproval), §3 (specSource traceability)
# and §4 (renderSpecConformanceGuidance) are shipped, independently verified
# by reading the cited files, not inferred from this frontmatter. The doc's
# own "Current state (recon)" section is retained but annotated as a
# drafting-time snapshot rather than rewritten, per docs/design/DESIGN-FORMAT.md
# rule 5. `emits-plan-gate-in-tasks-route` is unsuppressed below now that
# `implemented` no longer contradicts an all-pass ledger.
assertions:
  - id: "emits-plan-gate-in-tasks-route"
    type: "symbol_reachable"
    symbol: "emitsPlan"
    entry: "apps/web/src/app/api/tasks/route.ts"
    as: "assign"
  - id: "spec-source-context-type"
    type: "symbol"
    name: "SpecSourceContext"
    path: "apps/web/src/lib/approve-plan.ts"
  - id: "spec-conformance-reviewer-guidance"
    type: "symbol"
    name: "renderSpecConformanceGuidance"
    path: "apps/web/src/lib/reviewer.ts"
  - id: "emits-plan-mcp-allowlist"
    type: "config_key"
    key: "emitsPlan"
    file: "packages/core/mcp-tools.ts"
---

# spec-to-build-pattern

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/spec-to-build-pattern.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
