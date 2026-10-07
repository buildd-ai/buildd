---
status: implemented
assertions:
  - id: jwks-endpoint-route
    type: route
    method: GET
    path: /api/.well-known/jwks.json
    file: apps/web/src/app/api/.well-known/jwks.json/route.ts
  - id: assertion-mint-route
    type: route
    method: POST
    path: /api/connectors/[id]/assertion
    file: apps/web/src/app/api/connectors/[id]/assertion/route.ts
  - id: jwks-rotation-cron-route
    type: route
    method: GET
    path: /api/cron/jwks-rotation
    file: apps/web/src/app/api/cron/jwks-rotation/route.ts
  - id: connectors-assertion-audience-migration
    type: migration
    number: "0000"
    contains: assertion_audience
---

# cross-app-assertion-grant

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cross-app-assertion-grant.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
