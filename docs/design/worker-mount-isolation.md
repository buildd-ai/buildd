---
status: implemented
assertions:
  - id: mount-argv-symbol
    type: symbol
    name: buildWorkerBwrapArgv
    path: apps/runner/src/bwrap-mount-allowlist.ts
  - id: mount-argv-reachable
    type: symbol_reachable
    symbol: buildWorkerBwrapArgv
    entry: apps/runner/src/workers.ts
  - id: disable-sandbox-flag
    type: config_key
    key: BUILDD_DISABLE_SANDBOX
    file: apps/runner/src/bwrap-mount-allowlist.ts
  - id: bwrap-runtime-recovery-tests
    type: test_file
    path: apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
---

# worker-mount-isolation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/worker-mount-isolation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
