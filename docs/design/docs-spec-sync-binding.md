---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "public-spec-filter"
    type: "config_key"
    key: "user_facing"
    file: "scripts/check-specs.ts"
  - id: "json-export-output"
    type: "config_key"
    key: "specs.json"
    file: "scripts/check-specs.ts"
---

# docs-spec-sync-binding

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/docs-spec-sync-binding.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
