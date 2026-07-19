# Capability Specs Report

**Generated**: 2026-06-24  
**Derived from**: Code audit of `packages/core/db/schema.ts`, `apps/web/src/app/api/**`,
`apps/web/src/lib/`, `packages/core/`, and `docs/SPEC.md`.

---

## Spec Format

All specs follow the template defined in [SPEC-FORMAT.md](./SPEC-FORMAT.md):

```
## <Capability Name>
Capability statement · Invariants · Acceptance criteria · Code surface · Out of scope
```

Rules: ≥3 AC per block, no vague language, at least one error-path AC, all file
paths verified against the working tree.

---

## Coverage Table

| Capability | Spec file | Coverage | Key gaps |
|-----------|-----------|----------|---------|
| MCP action contracts | [mcp-action-contracts.md](./mcp-action-contracts.md) | Full | `spec_compare` AC count is minimal (admin-only, low risk) |
| Release flow | [release-flow.md](./release-flow.md) | Full | `script` strategy is spec'd but not yet implemented |
| Runner liveness | [runner-liveness.md](./runner-liveness.md) | Full | `attemptStaleRecovery` is spec'd but not called from a cron yet |
| Mission & task lifecycle | [mission-task-lifecycle.md](./mission-task-lifecycle.md) | Full | Sub-mission (`parentMissionId`) lifecycle not spec'd |
| Auth & OAuth boundaries | [auth-oauth-boundaries.md](./auth-oauth-boundaries.md) | Full | Team-level monthly budget enforcement not covered (cross-account aggregate tracking) |
| Knowledge store & retrieval | [knowledge-store-retrieval.md](./knowledge-store-retrieval.md) | Full | `TurbopufferStore` alternate backend not spec'd (deferred) |
| Webhook & realtime dataflow | [webhook-dataflow.md](./webhook-dataflow.md) | Full | Slack/Discord inbound slash commands not covered |

---

## Gap List

Capabilities that are **not yet spec'd** and the reason:

| Capability | Reason not spec'd now |
|-----------|-----------------------|
| Smart model routing (`task.kind`/`complexity` → `predictedModel`) | Out of scope for this task; see `packages/core/model-router.ts` and `packages/core/task-classifier.ts` — a dedicated spec would cover the classification taxonomy, routing algorithm, and calibration cron |
| File reservations (`file_reservations` table) | Advisory, not enforced — no hard contract to spec |
| Sub-mission lifecycle (`parentMissionId`) | Low usage, complex interaction with `maxConcurrentTasks`; deferred |
| Watcher / watched projects (`watched_projects`, `watcher_events`) | Important but narrow surface; spec would be straightforward — deferred for volume |
| Codex backend contracts | Already specified in `docs/codex-backend-spec.md` — no duplication needed |
| Credentials scoping & rotation | Already specified in `docs/credentials-architecture.md` |
| Slack / Discord inbound commands | Very thin wrapper routes, low value to spec independently |
| GitHub App sync (install/webhook/PR routing) | Broad surface, lower runtime risk than the 7 prioritized capabilities |
| Budget alerts and monthly cost tracking | Cross-account aggregate logic in `packages/core/budget-alerts.ts`; deferred |

---

## Prioritization Rationale

These 7 capabilities were selected because:

1. **MCP action contracts** — the primary interface for all agents. Bugs here
   break everything downstream. Multiple incident reports (2026-05 multi-workspace
   misroute) showed the need for a precise contract.

2. **Release flow** — irreversible (merges to `main`). A misfire or silent
   failure costs hours of recovery. The `resolve → preflight → dispatch → verify`
   pipeline has multiple failure modes worth documenting.

3. **Runner liveness** — the most operationally complex subsystem. Stale
   thresholds, heartbeat TTLs, retry caps, and `waiting_input` timeouts all
   interact. Mistakes here silently strand tasks.

4. **Mission & task lifecycle** — state machines are the core product invariant.
   The "derived health, not stored" pattern and the DAG unblocking contract are
   non-obvious and get broken by well-meaning changes.

5. **Auth & OAuth** — dual auth model with different billing creates multiple
   silent footguns (wrong limits applied, multi-workspace misroute). The PKCE
   flow has single-use / rotation invariants that are easy to break.

6. **Knowledge store** — the hybrid retrieval pipeline (vector + BM25 + RRF +
   rerank) with fallback-to-lexical is subtle. Agents rely on `query_knowledge`
   for planning context; incorrect retrieval is invisible until quality degrades.

7. **Webhook & realtime dataflow** — Pusher is the user-facing liveness signal.
   Missing or double-firing events create confusing UI. The webhook dispatch and
   notification paths have best-effort semantics that need to be documented
   explicitly.
