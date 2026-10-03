---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# start-task-endpoint and start-gate-tests genuinely shipped (see "Status"
# below) but this doc must stay `partially` until mcp-start-action — the
# design's actual proposal — ships too. Per-assertion classification flags
# any passing assertion under a non-terminal status as code_ahead regardless
# of whether the doc's own prose already says so, which would otherwise
# redispatch a reconcile-spec task against an already-accurate doc forever.
# Suppressed below (skip_until) rather than left to keep firing; re-verify
# and either renew or drop the suppression once mcp-start-action ships and
# the doc can promote to `implemented`.
assertions:
  - id: "start-task-endpoint"
    type: "route"
    method: "POST"
    path: "/api/tasks/[id]/start"
    file: "apps/web/src/app/api/tasks/[id]/start/route.ts"
    skip_until: "2026-12-19"
    skip_reason: "The /start route genuinely shipped (PRs #1241, #1512, #1677, #1894) — this isn't a false positive — but the doc must stay 'partially' until mcp-start-action ships, so this assertion will pass forever under a non-terminal status. mcp-start-action is the assertion that tracks real remaining progress."
  - id: "mcp-start-action"
    type: "symbol_reachable"
    symbol: "start_task"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
  - id: "start-gate-tests"
    type: "test_file"
    path: "apps/web/src/app/api/tasks/[id]/start/route.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "route.test.ts genuinely covers the shipped /start gates — this isn't a false positive — but the doc must stay 'partially' until mcp-start-action ships, so this assertion will pass forever under a non-terminal status. mcp-start-action is the assertion that tracks real remaining progress."
---

# mcp-start-task

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mcp-start-task.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
