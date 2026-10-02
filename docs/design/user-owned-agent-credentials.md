---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
# `secrets.userId` itself already exists (personal inference keys, PR #2832), so
# a check for the bare column cannot tell this design apart from that one. These
# assertions pin the pieces only this design adds: the agent-backend resolver,
# claim-time injection, and the runner refresh route reading the owner.
assertions:
  - id: "codex-resolver-user-owned"
    type: "symbol_reachable"
    symbol: "userId"
    entry: "apps/web/src/lib/codex-credential.ts"
    as: "read"
  - id: "refresh-route-user-owned-auth"
    type: "symbol_reachable"
    symbol: "userId"
    entry: "apps/web/src/app/api/runner/credential-refresh/route.ts"
    as: "read"
  - id: "claim-user-owned-credential"
    type: "symbol_reachable"
    symbol: "userId"
    entry: "apps/web/src/app/api/workers/claim/credential-injection.ts"
    as: "read"
---

# user-owned-agent-credentials

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/user-owned-agent-credentials.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
