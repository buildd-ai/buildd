---
status: draft
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "ingest-jobs-table"
    type: "symbol"
    name: "knowledgeIngestJobs"
    path: "packages/core/db/schema.ts"
  - id: "merged-pr-ingestion"
    type: "symbol_reachable"
    symbol: "enqueueMergedPrIngestJobs"
    entry: "apps/web/src/app/api/github/webhook/route.ts"
    as: "read"
  - id: "corpus-classifier"
    type: "symbol"
    name: "classifyIngestCorpus"
    path: "packages/core/knowledge-store/ingest-filter.ts"
---

# knowledge-elevation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/knowledge-elevation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
