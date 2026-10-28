---
title: Credential Refresh Lifecycle
status: superseded
owner: max
last_verified: 2026-10-28
summary: buildd no longer stores, refreshes or serves a subscription login, so there is nothing for it to rotate; the machine that owns a login refreshes it.
domain: auth
related: [credential-isolation, auth-oauth-boundaries, codex-backend-spec]
supersedes: []
superseded_by: living-spec:model-credentials
---

# Credential Refresh Lifecycle (retired)

This contract described buildd holding a rotating subscription login and
refreshing it from a runner-side broker. That subsystem is gone: the runner
uses its own `claude login` / `codex login`, and buildd keeps no login to
rotate. Kept as history only.
