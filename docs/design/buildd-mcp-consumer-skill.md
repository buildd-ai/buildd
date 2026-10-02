---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mcp-consumer-transport"
    type: "route"
    method: "POST"
    path: "/api/mcp"
    file: "apps/web/src/app/api/mcp/route.ts"
  - id: "consumer-skill-resource"
    type: "config_key"
    key: "buildd-mcp-consumer"
    file: "apps/web/src/app/api/mcp/route.ts"
  - id: "tracked-skill-catalog-tests"
    type: "test_file"
    path: "scripts/skills-listed.test.ts"
---

# buildd-mcp-consumer-skill

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/buildd-mcp-consumer-skill.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
