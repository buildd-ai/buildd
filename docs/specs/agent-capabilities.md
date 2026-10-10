---
title: Agent Capabilities
status: active
owner: max
last_verified: 2026-10-08
summary: An agent role MUST hold a platform capability (deploy, use a deploy credential, manage or reveal one) only through a named registry entry, a per-workspace opt-in, and a named target scope, failing closed.
domain: auth
surfaces: [apps/web/src/lib/permission-registry.ts, apps/web/src/lib/operator-capability.ts, apps/web/src/lib/operator-capability-source.ts, apps/web/src/lib/default-roles.ts]
related: [team-permissions, deployment-actions]
keywords: [platform operator, operator role, deployments:write, deployment_secrets:use, secrets:reveal, credential ref, deploy scope, metadata.operator]
verified_by: [apps/web/src/lib/operator-capability.test.ts, apps/web/src/lib/operator-capability-source.test.ts, apps/web/src/lib/default-roles.prompts.test.ts]
supersedes: []
assertions:
  - id: agent-capability-registry
    type: symbol
    name: AGENT_CAPABILITIES
    path: apps/web/src/lib/permission-registry.ts
  - id: role-capability-ceilings
    type: symbol
    name: ROLE_CAPABILITY_CEILINGS
    path: apps/web/src/lib/permission-registry.ts
  - id: elevated-agent-capabilities
    type: symbol
    name: ELEVATED_AGENT_CAPABILITIES
    path: apps/web/src/lib/permission-registry.ts
  - id: resolve-operator-grant
    type: symbol
    name: resolveOperatorGrant
    path: apps/web/src/lib/operator-capability.ts
  - id: authorize-agent
    type: symbol
    name: authorizeAgent
    path: apps/web/src/lib/operator-capability.ts
  - id: load-operator-grant
    type: symbol
    name: loadOperatorGrant
    path: apps/web/src/lib/operator-capability-source.ts
  - id: operator-prompt-id
    type: symbol
    name: OPERATOR_PROMPT_ID
    path: apps/web/src/lib/default-roles.ts
  - id: resolve-role-persona
    type: symbol
    name: resolveRolePersona
    path: apps/web/src/lib/default-roles.ts
  - id: role-persona-identity
    type: symbol
    name: rolePersonaIdentity
    path: apps/web/src/lib/default-roles.ts
  - id: operator-capability-test
    type: test_file
    path: apps/web/src/lib/operator-capability.test.ts
  - id: operator-capability-source-test
    type: test_file
    path: apps/web/src/lib/operator-capability-source.test.ts
---
# Agent Capabilities

What a task running under an agent **role** (a `workspaceSkills` row with
`isRole`) may do on the platform's behalf. Distinct from team permissions,
which say what a **human** team role may do: neither stands in for the other.

## Named capability registry

**Capability statement**: Each agent capability decision MUST be answerable
as "does role R hold capability C for target X in workspace W", where C is an
entry in `AGENT_CAPABILITIES` (`apps/web/src/lib/permission-registry.ts`).

**Invariants**:
- Capabilities are `deployments:read`, `deployments:write`,
  `deployment_secrets:use` (tier `standard`) and `deployment_secrets:manage`,
  `secrets:reveal` (tier `elevated`). Using a credential never implies
  managing or revealing it.
- A role holds a capability only if `ROLE_CAPABILITY_CEILINGS` lists it for
  that slug. Only `operator` (Platform Operator) has a ceiling; every other
  role, default or team-made, holds nothing, whatever its row metadata says.
- No role holds an elevated capability by default (`defaultRoleCapabilities`).
- The grant is stored as `metadata.operator` on the role's team default row
  and workspace override row. A workspace MUST opt in with `enabled: true`;
  a team default can disable the role everywhere but cannot enable it for a
  workspace. A disabled role row disables the grant.
- The team default's capability list and scope lists are ceilings; the
  workspace's lists narrow them. Elevated capabilities come only from an
  explicit workspace list.
- Scope has four dimensions: providers, projects, environments, credential
  refs. An unset or empty dimension allows nothing. `*` is never a wildcard:
  the sanitiser drops it and strict input parsing rejects it.
- An authorization decision's audit record names the credential reference,
  never a value, and flags elevated use.

**Acceptance criteria**:
- AC-1: GIVEN an Operator enabled in W with scope cloudflare / model-policy /
  production / cloudflare-prod WHEN `authorizeAgent` is asked for
  `deployment_secrets:use` on that target THEN it is allowed.
- AC-2: GIVEN the same grant WHEN asked for `secrets:reveal` or
  `deployment_secrets:manage` THEN it is denied `capability_not_granted`.
- AC-3: GIVEN only a team default row with `enabled: true` WHEN the grant for
  W is resolved THEN it is disabled.
- AC-4: GIVEN a builder role row carrying a full `metadata.operator` WHEN
  asked for any capability THEN it is denied `role_not_capable`.
- AC-5: GIVEN an enabled grant WHEN a target names a provider, project,
  environment or credential ref outside scope THEN it is denied with that
  dimension's `*_not_allowed` reason.
- AC-6: GIVEN a failed or empty db read WHEN `loadOperatorGrant` runs THEN it
  returns a disabled grant and does not throw.

## Admin UX

**Capability statement**: A holder of `manage_agent_roles` in the role's team
(owner and admin by default, see `docs/specs/team-permissions.md`) MUST be able
to read and edit a role's `metadata.operator` grant — team ceiling and
workspace opt-in separately — through the same team/workspace role settings
surface used for every other role field, never a parallel admin system, and
never see a credential value.

**Invariants**:
- Writing a grant needs `manage_agent_roles` in the role's team, with the
  team's permission overrides applied; anyone else sees the section read-only.
  A personal role never holds a grant (`operatorGrant` on one is a 400), and
  operator grants are never read from a personal row.
- `PATCH /api/roles/[id]` accepts `operatorGrant` (an `OperatorGrantConfig`, or
  `null` to clear) and writes it to `metadata.operator` on that row via
  `withOperatorGrantMetadata`, alongside `metadata.routing` and every other
  metadata key, untouched. A role with no entry in `ROLE_CAPABILITY_CEILINGS`
  rejects `operatorGrant` with 400: writing it would be inert, so it is
  refused rather than silently stored.
- `POST /api/roles/[id]/overrides` accepts the same `operatorGrant` field for
  a workspace override row, under the same ceiling check. Unlike every other
  overridable field, a new override row never inherits the team default's
  `metadata.operator` — the workspace's grant is its own opt-in, not a copy of
  the team's ceiling config.
- The role editor (`apps/web/src/app/app/(protected)/settings/roles/[slug]/edit/`)
  renders `OperatorAccessSection` instead of the generic workspace-overrides
  editor when the role's slug holds any agent capability. It shows: a team
  kill switch and standard-capability/scope ceiling; per workspace, an
  enabled toggle, deploy/use capabilities and secret management/reveal
  capabilities in two visually distinct groups (the latter unchecked by
  default), and scope chip lists; and a live effective-grant preview computed
  with `resolveOperatorGrant` from the current draft, before saving.
- No surface ever renders a credential value — scope only ever carries the
  reference string a credential was registered under.

**Code surface**: `apps/web/src/app/api/roles/[id]/route.ts`,
`apps/web/src/app/api/roles/[id]/overrides/route.ts`,
`apps/web/src/app/app/(protected)/settings/roles/[slug]/edit/OperatorAccessSection.tsx`.

## Operator persona

**Capability statement**: The Operator's persona text MUST resolve through the
versioned prompts table under id `buildd.role.operator`, with a plain public
fallback compiled into the repo, and MUST be identifiable by version and
fingerprint without its text.

**Invariants**:
- With no active row, `resolveRolePersona('operator')` returns the public
  text, `source: 'default'`, `promptVersion: v<role version>`, and counts one
  `missing` fallback for that id only.
- With an active row, it returns the row body, `promptVersion:
  v<role version>+p<row version>`, and a fingerprint equal to the row's
  content hash (the value `/api/deploy-identity` lists).
- `rolePersonaIdentity` carries slug, prompt id, source, version and
  fingerprint only, never the body.
- The persona grants nothing: authority comes from the grant above.
- Executing a deploy with a granted capability is
  [deployment-actions](deployment-actions.md).
- The Operator is not routable; a task carries the slug only when filed with it.

**Code surface**:
- `apps/web/src/lib/permission-registry.ts`: `AGENT_CAPABILITIES`,
  `ELEVATED_AGENT_CAPABILITIES`, `ROLE_CAPABILITY_CEILINGS`,
  `defaultRoleCapabilities`, `roleMayHold`, `OPERATOR_ROLE_SLUG`.
- `apps/web/src/lib/operator-capability.ts`: `resolveOperatorGrant`,
  `authorizeAgent`, `agentAuthorizationAudit`, `sanitizeOperatorGrantConfig`,
  `parseOperatorGrantInput`.
- `apps/web/src/lib/operator-capability-source.ts`: `loadOperatorGrant`.
- `apps/web/src/lib/default-roles.ts`: the `operator` role,
  `OPERATOR_PROMPT_ID`, `resolveRolePersona`, `rolePersonaIdentity`,
  `currentRolePersona`.
- `packages/core/prompts.ts`: `ResolvedPrompt.contentHash`.
