---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# Components 1-4 have shipped (run-once, the image, apps/cloud-runner, the
# egress handler). The canary (implementation step 6) has not run, and its
# assertion (cloud-canary-script) points at a script that does not exist yet,
# so the document stays `partially` until that lands.
# Phase 2: warm repos (WARM_REPOS) and resumable runs (RESUMABLE_RUNS) are both
# built, each behind a Worker var that defaults off.
# The five shipped-symbol assertions carry skip_until so they do not read as a
# case for promotion; the canary assertion is the one that gates `implemented`.
assertions:
  - id: "runner-run-once"
    type: "symbol"
    name: "runOnce"
    path: "apps/runner/src/run-once.ts"
    skip_until: "2026-12-01"
    skip_reason: "Shipped and passing; suppressed because this doc stays partially until the canary (implementation step 6, cloud-canary-script) runs and its script lands. The canary assertion is the one that gates promotion, so the shipped-symbol rows are held out rather than read as a reason to promote."
  - id: "cloud-worker-agent"
    type: "symbol"
    name: "WorkerAgent"
    path: "apps/cloud-runner/src/worker-agent.ts"
    skip_until: "2026-12-01"
    skip_reason: "Shipped and passing; suppressed because this doc stays partially until the canary (implementation step 6, cloud-canary-script) runs and its script lands. The canary assertion is the one that gates promotion, so the shipped-symbol rows are held out rather than read as a reason to promote."
  - id: "cloud-egress-handler"
    type: "symbol"
    name: "EgressHandler"
    path: "apps/cloud-runner/src/egress.ts"
    skip_until: "2026-12-01"
    skip_reason: "Shipped and passing; suppressed because this doc stays partially until the canary (implementation step 6, cloud-canary-script) runs and its script lands. The canary assertion is the one that gates promotion, so the shipped-symbol rows are held out rather than read as a reason to promote."
  - id: "cloud-snapshot-store"
    type: "symbol"
    name: "SnapshotStore"
    path: "apps/cloud-runner/src/snapshots.ts"
    skip_until: "2026-12-01"
    skip_reason: "Shipped and passing; suppressed because this doc stays partially until the canary (implementation step 6, cloud-canary-script) runs and its script lands. The canary assertion is the one that gates promotion, so the shipped-symbol rows are held out rather than read as a reason to promote."
  - id: "runner-warm-repo"
    type: "symbol"
    name: "WarmRepoSession"
    path: "apps/runner/src/warm-repo.ts"
    skip_until: "2026-12-01"
    skip_reason: "Shipped and passing; suppressed because this doc stays partially until the canary (implementation step 6, cloud-canary-script) runs and its script lands. The canary assertion is the one that gates promotion, so the shipped-symbol rows are held out rather than read as a reason to promote."
  - id: "cloud-canary-script"
    type: "test_file"
    path: "apps/cloud-runner/scripts/canary.sh"
---

# cloudflare-sandbox-runner

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cloudflare-sandbox-runner.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
