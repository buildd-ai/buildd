---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "ingest-jobs-table"
    type: "symbol"
    name: "knowledgeIngestJobs"
    path: "packages/core/db/schema.ts"
  - id: "merged-pr-ingestion"
    type: "symbol"
    name: "enqueueMergedPrIngestJobs"
    path: "apps/web/src/lib/knowledge-ingest.ts"
  - id: "entity-records"
    type: "symbol"
    name: "knowledgeEntities"
    path: "packages/core/db/schema.ts"
  - id: "knowledge-edges"
    type: "symbol"
    name: "knowledgeEdges"
    path: "packages/core/db/schema.ts"
---

# workspace-knowledge-management

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/workspace-knowledge-management.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
