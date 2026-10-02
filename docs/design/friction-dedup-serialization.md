---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "friction-intake"
    type: "route"
    method: "POST"
    path: "/api/tasks"
    file: "apps/web/src/app/api/tasks/route.ts"
  - id: "infer-friction-manifest"
    type: "symbol"
    name: "inferFrictionManifest"
    path: "packages/core/friction-manifest.ts"
  - id: "serialize-manifests"
    type: "symbol"
    name: "shouldSerializeByManifest"
    path: "packages/core/path-overlap.ts"
---

# friction-dedup-serialization

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/friction-dedup-serialization.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
