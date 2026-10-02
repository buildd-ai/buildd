---
status: implemented
assertions:
  - id: paths-overlap-symbol
    type: symbol
    name: pathsOverlap
    path: packages/core/path-overlap.ts
  - id: should-serialize-by-manifest-symbol
    type: symbol
    name: shouldSerializeByManifest
    path: packages/core/path-overlap.ts
  - id: find-blocking-pr-symbol
    type: symbol
    name: findBlockingPr
    path: packages/core/path-overlap.ts
  - id: path-claim-route
    type: route
    method: POST
    path: /api/tasks/[id]/path-claim
    file: apps/web/src/app/api/tasks/[id]/path-claim/route.ts
  - id: path-overlap-tests
    type: test_file
    path: packages/core/__tests__/path-overlap.test.ts
  - id: acquire-path-claims-symbol
    type: symbol
    name: acquirePathClaims
    path: packages/core/path-claim.ts
  - id: narrow-path-claims-symbol
    type: symbol
    name: narrowPathClaims
    path: packages/core/path-claim.ts
  - id: path-claim-narrow-route
    type: route
    method: DELETE
    path: /api/tasks/[id]/path-claim
    file: apps/web/src/app/api/tasks/[id]/path-claim/route.ts
  - id: path-claim-ownership-tests
    type: test_file
    path: packages/core/__tests__/path-claim-ownership.test.ts
---

# path-claims

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/path-claims.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
