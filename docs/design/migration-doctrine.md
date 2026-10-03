---
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "migration-plan"
    type: "symbol"
    name: "planMigrations"
    path: "packages/core/db/migrate-plan.ts"
  - id: "missing-schema-classifier"
    type: "symbol"
    name: "classifyMissingSchemaObjects"
    path: "packages/core/db/migrate-drift.ts"
  - id: "production-build-migrates"
    type: "test_file"
    path: "packages/core/__tests__/prod-build-runs-migrations.test.ts"
---

# migration-doctrine

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/migration-doctrine.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
