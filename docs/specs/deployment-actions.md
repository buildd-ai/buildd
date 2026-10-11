---
title: Deployment Actions
status: active
owner: max
last_verified: 2026-10-05
summary: A deploy MUST run server-side with a credential named by reference, authorized against the task role's workspace grant or an admin key, audited before use, never returning the credential.
domain: auth
surfaces: [apps/web/src/lib/deployments/action.ts, apps/web/src/lib/deployments/cloudflare.ts, apps/web/src/app/api/workers/[id]/deployments/route.ts, apps/web/src/app/api/deployments/route.ts]
related: [agent-capabilities]
keywords: [deploy action, platform operator, credential ref, deployment audit, deployment_audit_events, secrets:reveal, cloudflare deploy, model-policy deploy, upload_worker, put_secret]
verified_by: [apps/web/src/lib/deployments/action.test.ts, apps/web/src/app/api/workers/[id]/deployments/route.test.ts, apps/web/src/app/api/deployments/route.test.ts, apps/web/src/app/api/cloudflare/credential/reveal/route.test.ts, apps/model-policy/scripts/deploy-request.test.ts]
supersedes: []
assertions:
  - id: run-deployment-action
    type: symbol
    name: runDeploymentAction
    path: apps/web/src/lib/deployments/action.ts
  - id: deployment-operations
    type: symbol
    name: DEPLOYMENT_OPERATIONS
    path: apps/web/src/lib/deployments/action.ts
  - id: cloudflare-adapter
    type: symbol
    name: runCloudflareOperation
    path: apps/web/src/lib/deployments/cloudflare.ts
  - id: credential-ref-of
    type: symbol
    name: credentialRefOf
    path: apps/web/src/lib/deployments/store.ts
  - id: deployment-audit-table
    type: symbol
    name: deploymentAuditEvents
    path: packages/core/db/schema.ts
  - id: operator-deploy-route-post
    type: route
    method: POST
    path: /api/workers/[id]/deployments
    file: apps/web/src/app/api/workers/[id]/deployments/route.ts
  - id: admin-deploy-route-post
    type: route
    method: POST
    path: /api/deployments
    file: apps/web/src/app/api/deployments/route.ts
  - id: deployment-action-test
    type: test_file
    path: apps/web/src/lib/deployments/action.test.ts
---
# Deployment Actions

How buildd deploys on someone's behalf with a credential that someone never
holds. The authority model (which role may hold which capability, for which
targets) is [agent-capabilities](agent-capabilities.md); this spec is the
execution half.

## Server-side execution

**Capability statement**: A deployment operation MUST name a provider,
project, environment and credential reference, and buildd MUST resolve the
credential and call the provider itself, returning only a redacted result.

**Invariants**:
- Operations and the capabilities each needs (`DEPLOYMENT_OPERATIONS`):
  `status` needs `deployments:read`; `put_secret`, `upload_worker`,
  `ensure_bucket` need `deployments:write`. Every operation also needs
  `deployment_secrets:use`, because every one uses the credential. None
  needs `secrets:reveal` or `deployment_secrets:manage`.
- A credential reference is the stored row's label, lower-cased, or the
  provider name when the row has no label (`credentialRefOf`). Only
  team-wide rows (no workspace, no user) are resolved.
- Cloudflare: the Worker script is the project in `production` and
  `<project>-<environment>` elsewhere. A caller cannot name a script; an
  `ensure_bucket` bucket must start with `<script>-`.
- Results are built field by field from an allowlist: deployment id, time,
  source and version split; secret names; the workers.dev URL; upload etag.
  No provider body is passed through, and no author email.
- Provider error text has the token and account id removed and is capped.
  A thrown network error is replaced by a fixed message.
- A Worker secret value the caller sets is sent to the provider and never
  echoed or audited.

## Principals

**Capability statement**: A deployment action MUST run as either an
Operator task, authorized by its role's grant in its own workspace, or a
human admin API key, and nothing else.

**Invariants**:
- Operator: `POST /api/workers/[id]/deployments` (MCP action `deploy`).
  The caller is the worker's own account key or its per-task token, and the
  worker must be live. The grant read is the TASK's role in the TASK's
  workspace (`loadOperatorGrant`); a workspace in the body is ignored. Every
  capability of the operation is checked with `authorizeAgent` before the
  credential is read. A worker-level key is enough.
- Admin: `POST /api/deployments`. `bld_` keys at admin level only, the
  workspace must be in the key's team, not grant-checked. This is the
  escape hatch for people; it is audited the same way.
- Creating, rotating and deleting a credential stay on the existing admin
  paths (`POST`/`DELETE /api/secrets`, owner/admin only). No deployment
  operation can change a stored credential.
- `POST /api/cloudflare/credential/reveal` remains the only route that
  returns a credential: admin `bld_` keys only, and it writes an elevated
  `secrets:reveal` audit row before decrypting, refusing if it cannot.

## Audit trail

**Capability statement**: Every deployment action and every reveal MUST
leave a `deployment_audit_events` row naming who, where, what and the
credential reference, and never a credential value.

**Invariants**:
- A denial writes one `denied` row with the failing capability and reason.
- An allowed action writes a `started` row before the credential is read; if
  that write fails, nothing runs (503). The row is then settled `succeeded`
  (with the redacted result) or `failed` (with the scrubbed reason).
- Columns: team, workspace, task, worker, account, principal, role slug,
  operation, capabilities, elevated, provider, project, environment,
  credential ref, outcome, reason, result. None holds a credential.

**Acceptance criteria**:
- AC-1: GIVEN an Operator task in a workspace whose grant covers
  cloudflare / model-policy / production / cloudflare-prod WHEN it runs
  `upload_worker` on that target THEN the provider receives the token, and
  neither the reply nor any audit row contains the token or account id.
- AC-2: GIVEN the same grant WHEN the target names another project,
  environment, credential ref or provider THEN it is refused 403 with that
  dimension's reason, and neither the credential nor the provider is touched.
- AC-3: GIVEN a workspace that has not enabled the Operator WHEN its task
  calls deploy THEN it is refused `not_enabled`, whatever another workspace
  or the team default allows.
- AC-4: GIVEN a builder task, with any key level WHEN it calls deploy THEN
  it is refused `role_not_capable`.
- AC-5: GIVEN the audit store is down WHEN an allowed action is requested
  THEN it is refused 503 and the credential is not read.
- AC-6: GIVEN a provider error that quotes the token WHEN it is reported
  THEN the reply and the audit row carry `[redacted]` instead.
- AC-7: GIVEN an admin key WHEN it reveals the Cloudflare token THEN an
  elevated `secrets:reveal` row is written first.

## Deploy scripts

**Invariants**:
- `apps/model-policy/scripts/deploy.ts` builds with `wrangler deploy
  --dry-run` (no credential) and either writes the `upload_worker` request
  for an Operator's `deploy` action (`--emit`) or sends it to the admin
  route. No Cloudflare token is on the machine either way.
- `apps/cloud-runner/scripts/deploy.ts`, with the token stored in buildd,
  runs bucket, secret and status steps server-side. Only `wrangler deploy`
  (it builds and pushes the container image locally) fetches the token, via
  the audited reveal. `--secrets-only` skips it and needs no token. With
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set, everything runs
  locally as before.

**Code surface**:
- `apps/web/src/lib/deployments/action.ts`: `runDeploymentAction`,
  `parseDeploymentRequest`, `DEPLOYMENT_OPERATIONS`.
- `apps/web/src/lib/deployments/cloudflare.ts`: `runCloudflareOperation`,
  `parseCloudflareParams`, `cloudflareScriptName`, `scrubProviderText`.
- `apps/web/src/lib/deployments/store.ts`: `recordDeploymentAudit`,
  `settleDeploymentAudit`, `resolveDeploymentCredential`, `credentialRefOf`.
- `packages/core/db/schema.ts`: `deploymentAuditEvents`.
- `packages/core/mcp-tools.ts`: the `deploy` action.
