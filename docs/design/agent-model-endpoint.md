---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "agent-endpoint-resolver"
    type: "symbol"
    name: "resolveAgentModelRoute"
    path: "packages/core/agent-endpoint.ts"
  - id: "claim-attaches-endpoint"
    type: "symbol_reachable"
    symbol: "attachAgentEndpoints"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
  - id: "runner-applies-endpoint"
    type: "symbol_reachable"
    symbol: "mapAgentModel"
    entry: "apps/runner/src/agent-model-env.ts"
  - id: "cloud-route"
    type: "symbol_reachable"
    symbol: "resolveAgentModelRoute"
    entry: "apps/web/src/app/api/runner/model-endpoint/route.ts"
  - id: "ranking-tests"
    type: "test_file"
    path: "packages/core/__tests__/agent-endpoint-resolve.test.ts"
  - id: "claim-injection-tests"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/agent-endpoint-injection.test.ts"
  - id: "runner-env-invariant-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/agent-model-env.test.ts"
  - id: "tool-search-capability"
    type: "symbol"
    name: "effectiveToolSearch"
    path: "packages/core/agent-endpoint.ts"
  - id: "runner-applies-tool-search"
    type: "symbol_reachable"
    symbol: "TOOL_SEARCH_ENV"
    entry: "apps/runner/src/agent-model-env.ts"
  - id: "cloud-route-tests"
    type: "test_file"
    path: "apps/web/src/app/api/runner/model-endpoint/route.test.ts"
---

# agent-model-endpoint

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/agent-model-endpoint.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
