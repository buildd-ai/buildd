---
status: implemented
# Engine (schema, claim-time draw, readout core) and operator surfaces (REST
# /api/experiments, MCP `manage_experiments`, the /app/health section) are
# built. Still off by default: nothing enrolls until an admin starts an
# experiment. The open questions below remain open.
assertions:
  - id: "experiments-registry"
    type: "symbol"
    name: "experimentAssignments"
    path: "packages/core/db/schema.ts"
  - id: "claim-time-draw"
    type: "symbol"
    name: "drawModelRoutingArm"
    path: "packages/core/model-routing-experiment-source.ts"
  - id: "readout-core"
    type: "symbol"
    name: "computeExperimentReadout"
    path: "packages/core/experiment-readout.ts"
  - id: "experiments-api"
    type: "route"
    method: "GET"
    path: "/api/experiments"
    file: "apps/web/src/app/api/experiments/route.ts"
  - id: "experiments-mcp"
    type: "symbol"
    name: "EXPERIMENT_WRITE_OPS"
    path: "packages/core/mcp-tools.ts"
---

# model-routing-experiment

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/model-routing-experiment.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
