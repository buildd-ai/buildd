---
status: superseded
superseded_by: docs/specs/credential-refresh-lifecycle.md
superseded_on: "2026-10-28"
superseded_reason: >-
  buildd no longer stores a subscription login, so the Codex device login that
  captured one server-side, and its start/poll routes, are removed. A Codex
  login stays on the machine that owns it.
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "codex-device-start"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/codex-credential/device/start"
    file: "apps/web/src/app/api/workspaces/[id]/codex-credential/device/start/route.ts"
  - id: "codex-device-poll"
    type: "route"
    method: "POST"
    path: "/api/workspaces/[id]/codex-credential/device/poll"
    file: "apps/web/src/app/api/workspaces/[id]/codex-credential/device/poll/route.ts"
  - id: "device-auth-client"
    type: "symbol"
    name: "startCodexDeviceAuth"
    path: "apps/web/src/lib/codex-device-auth.ts"
---

# oauth-device-login

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/oauth-device-login.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
