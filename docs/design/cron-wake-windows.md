---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "redis-due-gate"
    type: "symbol"
    name: "decideDueGate"
    path: "apps/web/src/lib/cron-due-queue.ts"
  - id: "due-queue-gate"
    type: "symbol"
    name: "gateOnDueQueue"
    path: "apps/web/src/lib/cron-due-queue.ts"
  - id: "due-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/cron-due-queue.test.ts"
---

# cron-wake-windows

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cron-wake-windows.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
