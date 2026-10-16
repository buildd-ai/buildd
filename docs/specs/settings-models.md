---
title: Settings Models Page
status: active
owner: max
last_verified: 2026-10-13
summary: Settings › Team › Models MUST show one provider list, use a lone provider for every surface it serves, offer per-surface choice only at two or more, and put a person's own key before the team's.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/settings/models/page.tsx, apps/web/src/app/app/(protected)/settings/providers/ModelProvidersClient.tsx, packages/core/providers/policy.ts, packages/core/providers/resolve.ts]
related: [model-routing-and-tiers, model-policy-cells, provider-failover, team-permissions, credential-isolation]
keywords: [Models page, model providers, who pays, credential policy, personal_first, used for, provider routing, agent endpoint, LiteLLM gateway, decision model, workspace keys]
verified_by: [packages/core/__tests__/provider-assignments.test.ts, packages/core/__tests__/provider-resolve.test.ts, apps/web/src/app/api/providers/assignments/route.test.ts, apps/web/src/app/app/(protected)/settings/providers/providers-view.test.ts, apps/web/src/app/app/(protected)/settings/providers/ModelProvidersClient.dom.test.tsx, apps/web/src/app/app/(protected)/settings/models/page.test.ts, apps/web/src/app/app/(protected)/settings/workspace/[workspaceId]/page-groups.test.ts, apps/web/src/app/api/providers/route.test.ts]
supersedes: []
assertions:
  - id: "assignments-parse"
    type: "symbol"
    name: "parseProviderAssignments"
    path: "packages/core/providers/assignments.ts"
  - id: "assignments-route"
    type: "route"
    method: "PATCH"
    path: "/api/providers/assignments"
    file: "apps/web/src/app/api/providers/assignments/route.ts"
  - id: "used-for-only-at-two"
    type: "symbol"
    name: "usedForView"
    path: "apps/web/src/app/app/(protected)/settings/providers/providers-view.ts"
  - id: "lone-provider-line"
    type: "symbol"
    name: "loneProviderLine"
    path: "apps/web/src/app/app/(protected)/settings/providers/providers-view.ts"
  - id: "policy-default"
    type: "symbol"
    name: "surfacePolicy"
    path: "packages/core/providers/policy.ts"
  - id: "workspaces-with-keys"
    type: "symbol"
    name: "workspacesWithKeys"
    path: "apps/web/src/lib/providers/credentials.ts"
  - id: "names-the-team"
    type: "symbol"
    name: "providersTitle"
    path: "apps/web/src/app/app/(protected)/settings/providers/providers-view.ts"
---

# Settings Models Page

**Capability statement**: A team admin connects model providers in one list and
is done. buildd decides where each provider is used until there is a real
choice to make, a person's own key is spent before the team's, and a workspace
that needs something different says so on its own settings page.

This spec owns the page and the two rules it exposes (which provider serves a
surface, whose key pays). Which *model* a tier runs is
`model-routing-and-tiers` and `model-policy-cells`; what happens when a backend
is walled is `provider-failover`; who may change what is `team-permissions`.

## Sections

The page has, in this order: **Providers**, **Used for** (only with two or more
connected providers) and **Tiers**.

**Invariants**

- There is no Features section, no Routing section, no "Who pays" control and
  no Workspace keys section on the page.
- The page names no other app or page as the home of a removed control.
- Every control follows the permission its API enforces; a member sees the same
  page read-only.
- Someone in more than one team sees the Providers heading name the team the
  page holds ("Providers · <team>"), so "Not set" says whose. In one team the
  heading is "Providers".

**Acceptance criteria**

- AC-1: WHEN anyone opens `/app/settings/models` THEN the rendered headings are
  Providers, Used for (at two or more) and Tiers, and none of "Features", "Routing", "Who pays",
  "Workspace keys", "Decision features", "Chat session retros" appear.
  The Providers heading reads "Providers · <team>" for someone in more than
  one team.
- AC-2: GIVEN a member without `manage_inference_providers` WHEN they open the
  page THEN every provider row and picker is rendered without an editable
  control.

## Providers: one list

Every provider a team can connect is one row in one list, in registry order:
Claude (key or subscription), OpenAI (key or ChatGPT sign-in), OpenRouter,
LiteLLM gateway, and a custom Anthropic-compatible endpoint.

**Invariants**

- The LiteLLM gateway and the custom endpoint are rows in the list, connected,
  tested and removed the same way as a key; neither has a section of its own.
- A row shows whether it is connected and, at most, a count of members with
  their own key for it. It never shows a key beyond its last four characters.

**Acceptance criteria**

- AC-3: GIVEN a team with nothing connected WHEN the page loads THEN the list
  shows every registry provider, including the gateway and the custom endpoint,
  each with a connect action.

## Used for: a choice only when there is one

The surfaces are Chat, Claude Code runs, Codex runs, Cloud coding and
Decisions.

**Invariants**

- With **one** connected provider, it serves every surface it can serve and the
  page shows no assignment UI, only one line naming what it is used for. What
  it cannot serve is not listed there; the limit shows where someone acts.
- With **two or more**, a "Used for" table appears: one row per surface, one
  picker per row over the connected providers, plus Automatic (no pick). An
  option the surface cannot use is shown disabled with what it needs; it is
  never hidden silently.
- An unset row keeps the resolver's default ranking. A set row
  (`teams.provider_assignments`) puts that provider first within a scope and
  lets it win the endpoint tie; it never beats a more specific scope (a
  personal key still goes first) and never makes the resolver pick a
  credential it would otherwise refuse.
- The Claude/Codex provider switch is the Claude Code runs and Codex runs rows.
  It renders only when both backends are connected.
- The decision model is the Decisions row.

**Acceptance criteria**

- AC-4: GIVEN only OpenRouter connected WHEN the page loads THEN no "Used for"
  table renders, and one line reads "OpenRouter is used for …".
- AC-5: GIVEN OpenRouter and a Claude subscription connected WHEN the page
  loads THEN the "Used for" table renders a row per surface and a Decisions
  row; on the Chat row the subscription option is disabled with what it needs.
- AC-6: GIVEN Chat set to OpenRouter while an Anthropic key is also connected
  WHEN a chat turn resolves a credential THEN the OpenRouter credential is
  used.
- AC-7: GIVEN only Claude connected WHEN the page loads THEN no Claude/Codex
  switch renders.

## Whose key: personal first, team fallback

**Invariants**

- For chat **and** agent runs, a person's own key for the surface is used
  before the team's; the team's (or workspace's) key is the fallback. A team
  with no team key has no fallback: work without a personal key does not start
  and says which key is missing.
- A task with no human requester (filed by a mission, schedule or webhook) uses
  the team's credential.
- There is no setting for this on the page. A team that stored a different
  policy before this change keeps it, and sees one line naming it with a
  "Use the default" action that clears it.

**Acceptance criteria**

- AC-8: GIVEN a team that never set a policy, a team key and a member's own
  Anthropic key WHEN that member's task is claimed THEN the run is injected with
  the member's key.
- AC-9: GIVEN the same team WHEN a schedule-filed task is claimed THEN the run
  uses the team key.
- AC-10: GIVEN a team whose stored policy is `team` WHEN an admin chooses
  "Use the default" THEN the stored policy is cleared and AC-8 holds.

## Workspace overrides live on the workspace

**Invariants**

- Workspace keys and a workspace-scoped endpoint are set on that workspace's
  settings page, through the same provider list scoped to the workspace.
- The team Models page shows one line naming how many workspaces use their own
  keys, linking to them; at zero it shows nothing.

**Acceptance criteria**

- AC-11: GIVEN two workspaces with their own keys WHEN the team page loads
  THEN it shows one line naming 2 workspaces and no workspace picker.
- AC-12: WHEN a workspace's settings page loads THEN it shows "Uses <team>'s
  settings" or the workspace's own providers, with Override for an admin; a
  row inherited from the team reads "<team>'s key", naming the workspace's own
  team.

## Code surface

- Page: `apps/web/src/app/app/(protected)/settings/models/page.tsx`
- Provider list: `apps/web/src/app/app/(protected)/settings/providers/ModelProvidersClient.tsx`,
  `providers-view.ts` (`usedForView`, `loneProviderLine`), `UsedForSection.tsx`
- Assignments: `packages/core/providers/assignments.ts`,
  `apps/web/src/app/api/providers/assignments/route.ts`
- Resolver and policy: `packages/core/providers/resolve.ts`
  (`resolveProviderCredential`), `packages/core/providers/policy.ts`
- Claim injection: `apps/web/src/app/api/workers/claim/personal-credential-injection.ts`
- API: `apps/web/src/app/api/providers/route.ts`
- Shared types: `packages/shared/src/providers.ts`

## Verification gaps

- AC-8 to AC-10 (personal key first for agent runs) are held by the resolver
  and claim tests listed in `team-permissions` and `provider-resolve`; the
  dashboard copy for a stored non-default policy is not screenshot-tested.
