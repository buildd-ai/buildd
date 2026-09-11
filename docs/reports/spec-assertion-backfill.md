# Spec assertion backfill — checker output

> Generated audit snapshot, not a capability contract. Re-run the commands below after code or assertion changes.

Code baseline: `6b22cf2b8bfebe8166ea3075135bf3e1d2c68b5b` plus the assertion-only backfill in this change. No production database was queried.

## Coverage

The baseline discovered 110 documents: 108 assertion-free and two with existing assertions. This backfill adds 340 assertions to 107 documents. The remaining document, `docs/design/chat-integrations.md`, explicitly describes a removed implementation and disclaims a current contract. Its assertion-free status is intentional and annotated in its frontmatter; no escape-hatch enforcement is implied.

The backfill starts with active contracts and implemented designs, then route-bearing designs, migration claims, and call-site assertions. Route methods and exports were checked against source; failing literal design claims were retained for review. No status was promoted to make an assertion pass. Legacy quoted status headers were copied into frontmatter where necessary for the existing parser to read them. Prose-only status vocabulary remains unchanged.

| Checker-derived state | Documents |
| --- | ---: |
| `implemented` | 83 |
| `partial` | 17 |
| `failing` | 9 |
| `unverified` | 1 |

Assertions: **354** — **310 pass**, **41 fail**, **3 suppressed**. Validation errors: **0**.

Document-level status contradictions: **24**. These differ from the per-assertion ledger classifications below.

## Ledger dry run

`bun run specs:discrepancies --dry-run` reports:

| Classification | Assertions |
| --- | ---: |
| `code_ahead` | 100 |
| `contradicted` | 1 |
| `clean` | 179 |
| `skip` | 74 |

On an empty ledger this would insert 101 rows. This is a dry-run projection, not a count of persisted rows. No ledger writes were performed. Tier 2 never produces `spec_ahead`: a failed static lookup cannot distinguish unbuilt work from renamed or moved code.

`classifyAssertion` classifies each passing assertion under a recognized nonterminal declaration as `code_ahead`, even when another assertion in the same document fails. A `code_ahead` row therefore identifies a passing structural claim, not proof that the entire proposal has shipped. Failures under nonterminal declarations are `clean` (expected work in progress); suppressed assertions and unrecognized/retired status vocabulary are `skip`. The failure table below keeps those results visible.

## Findings and scope decisions

- **Implemented failover design:** `failure-classification-contract` does not resolve at its explicitly promised core path. The web helper with the same name uses a different failure taxonomy, so it is not substituted. This is `contradicted`, requiring adjudication rather than an automatic build recommendation.
- **Known incomplete contracts:** scheduled merge-policy propagation, archive-time heartbeat retirement, the released criterion, and MCP `start_task` each retain an assertion on the required field or action at the named consuming path. The synchronous `ask` design retains its proposed route and table claims.
- **The checker checks itself:** `spec-conformance.md` now asserts its evaluator, ledger table, regression tests, delta-gate tests, and proposed promotion action. The missing action keeps its derived status partial rather than making the entire design look shipped from the evaluator alone.
- **Do not assert withdrawn proposals:** the unified IA design explicitly defers a separate workspace-override table. The inference design withdraws migration of its dead classifier and still requests migration of the screenshot judge. Assertions follow those amendments.
- **Resolved source locations:** timestamp/display functions live in `task-presentation.ts`; the mount builder is `buildWorkerBwrapArgv` in `bwrap-mount-allowlist.ts`; release archetype detection lives in `packages/core/release-archetype.ts`. These use the actual named implementations, not nearby functions with similar names.
- **Literal stale test reference:** `retry-continuity.md` names `apps/runner/__tests__/unit/worktree-utils.test.ts`, which is absent. The assertion keeps that exact reference visible; it does not claim the retry behavior is absent.
- **Pre-existing column assertions:** the two failures in `mission-goal-criteria.md` predate this backfill. They ask the export-only `symbol` checker to find table fields (`goalCriteria`, `kpis`), which are not standalone exports. They are not evidence that the columns are missing. The existing blocks and suppression dates were left untouched.
- **Historical exception:** the retired chat note is not revived or given an assertion on an unrelated surviving endpoint merely to reach zero unverified documents.

## What a passing assertion establishes

Each new frontmatter block states the structural scope. `route` verifies a file exports the stated HTTP method; it does not execute authorization or routing. `symbol` verifies an exported identifier. `symbol_reachable` is a textual check at a named consumer, not an AST call graph or execution trace; selected runner, claim, completion, and rendered-view call sites were also inspected. `config_key` verifies a literal occurrence, not its runtime value. `test_file` verifies presence, not that every prose invariant has a test. Migration assertions check committed SQL only, not application to a live database.

Consequently, the checker-derived word `implemented` below means all declared structural assertions passed. It does not certify the whole document, visual parity, full behavioral coverage, deployment, or absence of the verification gaps already recorded in its prose.

## Reproduce

```bash
bun run specs:check
bun run specs:lint
bun run specs:conformance
bun run specs:conformance --json
bun run specs:discrepancies --dry-run
```

Validation: `specs:check` and `specs:lint` pass (existing warnings remain); `env -u BUILDD_DISABLE_SANDBOX bun run test` passes all 730 isolated test files; `bun run type-check` passes; `cd apps/web && bunx next build` passes. The first unit run inherited the runner sandbox-disable flag and failed probe-success tests; the clean test process removes only that inherited variable. The normal `bun run build` migration pre-step cannot run without `DATABASE_URL` in the worker sandbox. The direct Next build validates application compilation and prerendering without running that migration step.

## Per-document results

Pass/fail/skip in this table are assertion outcomes, not ledger classifications. A dash means no declaration was parsed.

| Document | Declared | Checker derived | Pass / fail / suppressed |
| --- | --- | --- | ---: |
| [design/ask-synchronous-qa.md](../design/ask-synchronous-qa.md) | `proposed` | `failing` | 0 / 2 / 0 |
| [design/backend-failover-policy.md](../design/backend-failover-policy.md) | `implemented` | `partial` | 3 / 1 / 0 |
| [design/buildd-mcp-consumer-skill.md](../design/buildd-mcp-consumer-skill.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/cancellation-must-resolve.md](../design/cancellation-must-resolve.md) | `proposed` | `partial` | 1 / 2 / 0 |
| [design/cbm-v2-warm-start.md](../design/cbm-v2-warm-start.md) | `proposed` | `failing` | 0 / 3 / 0 |
| [design/cbm-workspace-service.md](../design/cbm-workspace-service.md) | `proposed` | `implemented` | 2 / 0 / 0 |
| [design/change-intent.md](../design/change-intent.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/chat-integrations.md](../design/chat-integrations.md) | `retired — record of a removed implementation` | `unverified` | 0 / 0 / 0 |
| [design/cloudflare-sandbox-runner.md](../design/cloudflare-sandbox-runner.md) | `proposed` | `partial` | 1 / 1 / 0 |
| [design/codebase-memory-mcp-integration.md](../design/codebase-memory-mcp-integration.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/connector-availability-degraded-mode.md](../design/connector-availability-degraded-mode.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/convergence-layer.md](../design/convergence-layer.md) | `proposed` | `partial` | 2 / 2 / 0 |
| [design/cron-wake-windows.md](../design/cron-wake-windows.md) | `accepted` | `implemented` | 3 / 0 / 0 |
| [design/cross-app-assertion-grant.md](../design/cross-app-assertion-grant.md) | `draft` | `implemented` | 4 / 0 / 0 |
| [design/cross-workspace-retrieval.md](../design/cross-workspace-retrieval.md) | `proposed` | `failing` | 0 / 2 / 0 |
| [design/deliverable-uniqueness.md](../design/deliverable-uniqueness.md) | `proposed` | `failing` | 0 / 3 / 0 |
| [design/derived-metric-availability.md](../design/derived-metric-availability.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/derived-state-accessors.md](../design/derived-state-accessors.md) | `proposed` | `partial` | 2 / 1 / 0 |
| [design/docs-spec-sync-binding.md](../design/docs-spec-sync-binding.md) | `proposed` | `failing` | 0 / 2 / 0 |
| [design/friction-dedup-serialization.md](../design/friction-dedup-serialization.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/generic-mcp-connectors.md](../design/generic-mcp-connectors.md) | `draft` | `implemented` | 4 / 0 / 0 |
| [design/github-comment-mentions.md](../design/github-comment-mentions.md) | `proposed` | `partial` | 1 / 1 / 0 |
| [design/inference-calls-primitive.md](../design/inference-calls-primitive.md) | `partially` | `partial` | 2 / 1 / 0 |
| [design/initiative-surfaces.md](../design/initiative-surfaces.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/knowledge-elevation.md](../design/knowledge-elevation.md) | `draft` | `implemented` | 3 / 0 / 0 |
| [design/knowledge-graph-retrieval.md](../design/knowledge-graph-retrieval.md) | `draft` | `implemented` | 4 / 0 / 0 |
| [design/knowledge-tool-surface.md](../design/knowledge-tool-surface.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/linear-hierarchy-ingest.md](../design/linear-hierarchy-ingest.md) | `phase` | `implemented` | 3 / 0 / 0 |
| [design/loop-until-verified.md](../design/loop-until-verified.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/mcp-start-task.md](../design/mcp-start-task.md) | `proposed` | `partial` | 2 / 1 / 0 |
| [design/merge-policy.md](../design/merge-policy.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/migration-doctrine.md](../design/migration-doctrine.md) | `—` | `implemented` | 3 / 0 / 0 |
| [design/mission-context-clusters.md](../design/mission-context-clusters.md) | `partially` | `partial` | 2 / 1 / 0 |
| [design/mission-delivery-arc.md](../design/mission-delivery-arc.md) | `accepted` | `implemented` | 3 / 0 / 0 |
| [design/mission-goal-criteria.md](../design/mission-goal-criteria.md) | `superseded` | `partial` | 5 / 2 / 0 |
| [design/mission-state-ownership.md](../design/mission-state-ownership.md) | `accessor` | `implemented` | 3 / 0 / 0 |
| [design/mission-state-progress.md](../design/mission-state-progress.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/mission-status-mobile-header-spec.md](../design/mission-status-mobile-header-spec.md) | `normative` | `implemented` | 3 / 0 / 0 |
| [design/mobile-artifact-feed.md](../design/mobile-artifact-feed.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/mobile-decision-flow.md](../design/mobile-decision-flow.md) | `partially` | `implemented` | 3 / 0 / 0 |
| [design/mobile-feed-spec.md](../design/mobile-feed-spec.md) | `reference` | `implemented` | 3 / 0 / 0 |
| [design/mobile-filter-pattern.md](../design/mobile-filter-pattern.md) | `implemented` | `implemented` | 2 / 0 / 0 |
| [design/model-tiers.md](../design/model-tiers.md) | `implemented` | `implemented` | 4 / 0 / 0 |
| [design/oauth-device-login.md](../design/oauth-device-login.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/path-claims-coordination.md](../design/path-claims-coordination.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/path-claims.md](../design/path-claims.md) | `implemented` | `implemented` | 4 / 0 / 0 |
| [design/private-task-execution.md](../design/private-task-execution.md) | `spec` | `failing` | 0 / 2 / 0 |
| [design/release-handoff-workflow.md](../design/release-handoff-workflow.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/release-management-ui.md](../design/release-management-ui.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/reliable-env-provisioning.md](../design/reliable-env-provisioning.md) | `phases` | `implemented` | 3 / 0 / 0 |
| [design/retry-continuity.md](../design/retry-continuity.md) | `partially` | `partial` | 2 / 1 / 0 |
| [design/review-gate-ux.md](../design/review-gate-ux.md) | `proposed` | `implemented` | 4 / 0 / 0 |
| [design/reviewer-evidence-and-verification.md](../design/reviewer-evidence-and-verification.md) | `proposed` | `partial` | 2 / 1 / 0 |
| [design/roles-scoping.md](../design/roles-scoping.md) | `—` | `implemented` | 3 / 0 / 0 |
| [design/runner-oauth-broker.md](../design/runner-oauth-broker.md) | `proposed` | `partial` | 4 / 0 / 3 |
| [design/runner-workspace-isolation.md](../design/runner-workspace-isolation.md) | `partially` | `implemented` | 3 / 0 / 0 |
| [design/settings-ia-refactor.md](../design/settings-ia-refactor.md) | `authoritative` | `implemented` | 2 / 0 / 0 |
| [design/spec-conformance.md](../design/spec-conformance.md) | `proposed` | `partial` | 4 / 1 / 0 |
| [design/status-reconciliation.md](../design/status-reconciliation.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/task-classification-and-wait.md](../design/task-classification-and-wait.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/task-model-visibility.md](../design/task-model-visibility.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/task-presentation.md](../design/task-presentation.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/task-status-timestamps.md](../design/task-status-timestamps.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/task-subject-anchors.md](../design/task-subject-anchors.md) | `accepted` | `implemented` | 3 / 0 / 0 |
| [design/task-tier-presentation.md](../design/task-tier-presentation.md) | `proposed` | `failing` | 0 / 3 / 0 |
| [design/unified-app-ia.md](../design/unified-app-ia.md) | `phase` | `implemented` | 2 / 0 / 0 |
| [design/unified-sharing-model.md](../design/unified-sharing-model.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/user-owned-agent-credentials.md](../design/user-owned-agent-credentials.md) | `proposed` | `failing` | 0 / 2 / 0 |
| [design/worker-mount-isolation.md](../design/worker-mount-isolation.md) | `implemented` | `implemented` | 4 / 0 / 0 |
| [design/worker-pr-automerge.md](../design/worker-pr-automerge.md) | `proposed` | `implemented` | 3 / 0 / 0 |
| [design/workspace-knowledge-management.md](../design/workspace-knowledge-management.md) | `accepted` | `implemented` | 4 / 0 / 0 |
| [design/workspace-memory-digest-arm.md](../design/workspace-memory-digest-arm.md) | `implemented` | `implemented` | 3 / 0 / 0 |
| [design/workspace-migration.md](../design/workspace-migration.md) | `approved` | `implemented` | 4 / 0 / 0 |
| [design/workspace-policy-engine.md](../design/workspace-policy-engine.md) | `proposed` | `failing` | 0 / 3 / 0 |
| [specs/artifacts-and-sharing.md](../specs/artifacts-and-sharing.md) | `active` | `implemented` | 5 / 0 / 0 |
| [specs/auth-oauth-boundaries.md](../specs/auth-oauth-boundaries.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/codebase-memory-graph.md](../specs/codebase-memory-graph.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/codex-backend-spec.md](../specs/codex-backend-spec.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/credential-isolation.md](../specs/credential-isolation.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/credential-refresh-lifecycle.md](../specs/credential-refresh-lifecycle.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/db-migration-gates.md](../specs/db-migration-gates.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/external-cron-triggers.md](../specs/external-cron-triggers.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/human-in-the-loop-protocol.md](../specs/human-in-the-loop-protocol.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/knowledge-ingest-pipeline.md](../specs/knowledge-ingest-pipeline.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/knowledge-store-retrieval.md](../specs/knowledge-store-retrieval.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/mcp-action-contracts.md](../specs/mcp-action-contracts.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/mcp-connectors-and-roles.md](../specs/mcp-connectors-and-roles.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/migration-execution.md](../specs/migration-execution.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/mission-heartbeat-schedule-lifecycle.md](../specs/mission-heartbeat-schedule-lifecycle.md) | `draft` | `partial` | 2 / 1 / 0 |
| [specs/mission-release-gate.md](../specs/mission-release-gate.md) | `draft` | `partial` | 2 / 1 / 0 |
| [specs/mission-structure-view.md](../specs/mission-structure-view.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/mission-task-lifecycle.md](../specs/mission-task-lifecycle.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/missions-tab-triage.md](../specs/missions-tab-triage.md) | `superseded` | `implemented` | 3 / 0 / 0 |
| [specs/model-routing-and-tiers.md](../specs/model-routing-and-tiers.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/oauth-provider-and-jwks.md](../specs/oauth-provider-and-jwks.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/pr-lifecycle-reconciliation.md](../specs/pr-lifecycle-reconciliation.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/provider-failover.md](../specs/provider-failover.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/release-flow.md](../specs/release-flow.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/runner-liveness.md](../specs/runner-liveness.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/scheduled-task-merge-policy.md](../specs/scheduled-task-merge-policy.md) | `draft` | `partial` | 2 / 1 / 0 |
| [specs/subject-anchor-liveness.md](../specs/subject-anchor-liveness.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/surface-ia-home-missions-initiatives.md](../specs/surface-ia-home-missions-initiatives.md) | `draft` | `implemented` | 3 / 0 / 0 |
| [specs/team-namespace-scoping.md](../specs/team-namespace-scoping.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/team-workspace-mission-onboarding.md](../specs/team-workspace-mission-onboarding.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/timeline-dependency-geometry.md](../specs/timeline-dependency-geometry.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/timezone-resolution.md](../specs/timezone-resolution.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/usage-and-cost-accounting.md](../specs/usage-and-cost-accounting.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/webhook-dataflow.md](../specs/webhook-dataflow.md) | `active` | `implemented` | 4 / 0 / 0 |
| [specs/work-tracker-integration.md](../specs/work-tracker-integration.md) | `active` | `implemented` | 3 / 0 / 0 |
| [specs/worker-sandbox-isolation.md](../specs/worker-sandbox-isolation.md) | `active` | `implemented` | 4 / 0 / 0 |

## Failed assertion output

These are the checker results verbatim. Their direction depends on the declaration, as explained above; none is an automatic `spec_ahead` verdict.

| Document | Assertion ID | Checker detail |
| --- | --- | --- |
| `docs/design/ask-synchronous-qa.md` | `synchronous-ask` | route file not found: apps/web/src/app/api/ask/route.ts |
| `docs/design/ask-synchronous-qa.md` | `ask-records` | no exported "asks" found in packages/core/db/schema.ts |
| `docs/design/backend-failover-policy.md` | `failure-classification-contract` | file not found: packages/core/failure-classification.ts |
| `docs/design/cancellation-must-resolve.md` | `cancel-disposition` | no read of "dependentDisposition" found in apps/web/src/app/api/tasks/[id]/route.ts |
| `docs/design/cancellation-must-resolve.md` | `hard-edge-gate` | no read of "hardDependsOn" found in apps/web/src/app/api/workers/claim/deps-gate.ts |
| `docs/design/cbm-v2-warm-start.md` | `canonical-seed` | no exported "seedFromCanonical" found in apps/runner/src/cbm-bootstrap.ts |
| `docs/design/cbm-v2-warm-start.md` | `canonical-db-name` | no exported "deriveCbmDbName" found in apps/runner/src/cbm-bootstrap.ts |
| `docs/design/cbm-v2-warm-start.md` | `canonical-seed-called` | no read of "seedFromCanonical" found in apps/runner/src/cbm-bootstrap.ts |
| `docs/design/cloudflare-sandbox-runner.md` | `runner-substrate-interface` | file not found: apps/runner/src/substrates/types.ts |
| `docs/design/convergence-layer.md` | `green-ci-policy` | "enforceGreenCI" not found in packages/shared/src/types.ts |
| `docs/design/convergence-layer.md` | `merge-order-edges` | "mergeAfter" not found in packages/shared/src/types.ts |
| `docs/design/cross-workspace-retrieval.md` | `cross-workspace-opt-in` | "crossWorkspaceDocs" not found in packages/core/db/schema.ts |
| `docs/design/cross-workspace-retrieval.md` | `readable-workspace-resolution` | no read of "resolveReadableWorkspaces" found in packages/core/mcp-tools.ts |
| `docs/design/deliverable-uniqueness.md` | `deliverable-manifest` | "deliverableManifest" not found in packages/core/db/schema.ts |
| `docs/design/deliverable-uniqueness.md` | `deliverable-claims-table` | "deliverable_claims" not found in packages/core/db/schema.ts |
| `docs/design/deliverable-uniqueness.md` | `deliverable-intake-result` | no read of "deliverable_claimed" found in apps/web/src/app/api/tasks/route.ts |
| `docs/design/derived-state-accessors.md` | `pr-terminal-accessor` | no exported "isPrTerminal" found in apps/web/src/lib/task-presentation.ts |
| `docs/design/docs-spec-sync-binding.md` | `public-spec-filter` | "user_facing" not found in scripts/check-specs.ts |
| `docs/design/docs-spec-sync-binding.md` | `json-export-output` | "specs.json" not found in scripts/check-specs.ts |
| `docs/design/github-comment-mentions.md` | `issue-comment-dispatch` | no read of "issue_comment" found in apps/web/src/app/api/github/webhook/route.ts |
| `docs/design/inference-calls-primitive.md` | `visual-judge-uses-inference-client` | no read of "inferenceCall" found in apps/web/src/app/api/qa/judge/route.ts |
| `docs/design/mcp-start-task.md` | `mcp-start-action` | no read of "start_task" found in packages/core/mcp-tools.ts |
| `docs/design/mission-context-clusters.md` | `durable-context-assembly-table` | "assembly_id" not found in packages/core/db/schema.ts |
| `docs/design/mission-goal-criteria.md` | `goal-criteria-column` | no exported "goalCriteria" found in packages/core/db/schema.ts |
| `docs/design/mission-goal-criteria.md` | `kpis-column` | no exported "kpis" found in packages/core/db/schema.ts |
| `docs/design/private-task-execution.md` | `visibility-filter` | file not found: apps/web/src/lib/task-visibility.ts |
| `docs/design/private-task-execution.md` | `oauth-client-owner` | "ownerClientId" not found in packages/core/db/schema.ts |
| `docs/design/retry-continuity.md` | `retry-worktree-tests` | apps/runner/__tests__/unit/worktree-utils.test.ts does not exist |
| `docs/design/reviewer-evidence-and-verification.md` | `request-changes-verifier` | file not found: apps/web/src/lib/reviewer-verify.ts |
| `docs/design/spec-conformance.md` | `promote-discrepancy-action` | no read of "promote_discrepancy" found in packages/core/mcp-tools.ts |
| `docs/design/task-tier-presentation.md` | `tiered-count` | file not found: packages/core/task-count.ts |
| `docs/design/task-tier-presentation.md` | `tiered-count-tests` | packages/core/__tests__/task-count.test.ts does not exist |
| `docs/design/task-tier-presentation.md` | `mission-api-tier-counts` | no read of "tierCounts" found in apps/web/src/app/api/missions/[id]/route.ts |
| `docs/design/user-owned-agent-credentials.md` | `user-owned-secret-field` | "userId" not found in packages/core/secrets/types.ts |
| `docs/design/user-owned-agent-credentials.md` | `claim-user-owned-credential` | no read of "userId" found in apps/web/src/app/api/workers/claim/credential-injection.ts |
| `docs/design/workspace-policy-engine.md` | `workspace-policies` | no exported "workspacePolicies" found in packages/core/db/schema.ts |
| `docs/design/workspace-policy-engine.md` | `structured-question-decision` | "decisionRecord" not found in packages/shared/src/types.ts |
| `docs/design/workspace-policy-engine.md` | `policy-management-action` | no read of "manage_workspace_policies" found in packages/core/mcp-tools.ts |
| `docs/specs/mission-heartbeat-schedule-lifecycle.md` | `archive-retires-schedules` | no read of "taskSchedules" found in apps/web/src/lib/mission-archive.ts |
| `docs/specs/mission-release-gate.md` | `released-criterion` | no read of "released" found in packages/core/mission-helpers.ts |
| `docs/specs/scheduled-task-merge-policy.md` | `schedule-copies-merge-policy` | no read of "mergePolicy" found in apps/web/src/app/api/cron/schedules/route.ts |
