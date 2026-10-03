---
status: implemented
# Promoted on merge of #2786/#2787/#2788. Each assertion names a shipped piece:
# the scoped role gate, code-derived routes, the evidence check on completion,
# and the qa/ screenshot key minted at upload. The generic multi-workspace
# phase in "Implementation sketch" is still unbuilt and carries no assertion.
assertions:
  - id: "explicit-role-gate"
    type: "symbol_reachable"
    symbol: "roleSlugGate"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
  - id: "required-routes-from-files"
    type: "symbol"
    name: "requiredRoutes"
    path: "packages/core/visual-qa-routes.ts"
  - id: "evidence-check-on-completion"
    type: "symbol_reachable"
    symbol: "loadVisualAuditEvidence"
    entry: "apps/web/src/app/api/workers/[id]/route.ts"
  - id: "qa-key-minted-at-upload"
    type: "symbol_reachable"
    symbol: "buildAuditScreenshotKey"
    entry: "apps/web/src/app/api/artifacts/upload-url/route.ts"
---

# visual-qa-auditor

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/visual-qa-auditor.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
