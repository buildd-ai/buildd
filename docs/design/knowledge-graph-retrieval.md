---
status: draft
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "recency-authority"
    type: "symbol"
    name: "applyRecencyAuthority"
    path: "packages/core/knowledge-store/recency-authority.ts"
  - id: "knowledge-entities"
    type: "symbol"
    name: "knowledgeEntities"
    path: "packages/core/db/schema.ts"
  - id: "knowledge-edges"
    type: "symbol"
    name: "knowledgeEdges"
    path: "packages/core/db/schema.ts"
  - id: "graph-schema-migration"
    type: "migration"
    number: "0000"
    contains: "knowledge_edges"
---

# knowledge-graph-retrieval

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/knowledge-graph-retrieval.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
