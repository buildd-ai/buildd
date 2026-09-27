# Connectors with per-person identity, a curated catalog, and an org layer

**Status:** Proposed
**Related:** `packages/core/db/schema.ts` (`teams`, `teamMembers`, `accounts`, `tasks`, `missions`, `taskSchedules`, `secrets`, `connectors`, `connectorWorkspaces`, `connectorShares`, `workspaceSkills.connectorRefs`), `apps/web/src/app/api/workers/claim/mcp-connector-injection.ts`, `apps/web/src/app/api/workers/claim/connector-prefilter.ts`, `apps/web/src/app/api/workers/claim/connector-gate.ts`, `apps/web/src/app/api/connectors/route.ts`, `apps/web/src/app/api/connectors/callback/route.ts`, `apps/web/src/lib/mcp-connector-refresh.ts`, `apps/web/src/lib/connector-status.ts`, `apps/web/src/lib/connector-queries.ts`, `apps/web/src/lib/chat/registry.ts`, `apps/web/src/lib/chat/reach-rules.ts`, `apps/web/src/lib/team-access.ts`, `packages/core/inference-keys.ts`, `packages/core/secrets/postgres-provider.ts`, `apps/web/src/app/app/(protected)/settings/connectors/ConnectionsClient.tsx`, `docs/specs/mcp-connectors-and-roles.md`, `docs/specs/credential-isolation.md`, `docs/specs/team-namespace-scoping.md`, `docs/credentials-architecture.md`, `docs/design/generic-mcp-connectors.md`, `docs/design/connector-availability-degraded-mode.md`, `docs/design/cross-app-assertion-grant.md`, `docs/design/agent-chat.md`, `docs/design/chat-integrations.md`

---

## Problem

A team connects Slack once, and every agent run in the team posts as that one
Slack identity. Nobody can say "search *my* Slack" or "draft a reply in *my*
Gmail", because a connector holds exactly one credential and it belongs to the
team. `docs/specs/mcp-connectors-and-roles.md` §7 lists "per-account (personal)
connector tokens" as out of scope, and `docs/design/generic-mcp-connectors.md`
open question 2 asks the same thing and leaves it.

Three more gaps sit next to that one:

- **Every connector is hand-built.** Settings → MCP connectors takes a URL and
  runs OAuth discovery. An admin who wants Linear has to know the Linear MCP URL,
  and nobody has chosen scopes or a tool subset for them. The registry browser
  in the role editor lists whatever the public MCP registry returns, with no
  review.
- **Admins can't govern connectors.** `POST /api/connectors` checks for team
  admin and nothing else. No setting lets an admin hide a connector, allow
  members to add their own, or stop custom URLs.
- **Nothing sits above a team.** A company with four teams configures Slack four
  times, sets four budgets and has no single place to see which team reaches
  which system. `connector_shares` (§1b) lets one team lend a connector to
  another, one pair at a time. buildd has no org, no SSO and no SCIM.

Chat makes the identity gap sharper. `docs/design/agent-chat.md` reserves
`createMCPClient` for third-party connectors, and no chat code calls it today.
When chat gets Vercel logs or Sentry issues, it has to answer "whose token?" for
a person typing in a server route, and the only answer today is "the team's".

## Current state

- **One credential per connector.** `resolveMcpConnectorsForTask`
  (`mcp-connector-injection.ts`) loads `secrets` rows with
  `purpose = 'mcp_connector_credential'` and `label IN (connectorIds)`, keyed on
  the connector's owner team, and puts them in a map keyed by label. **The query
  has no `userId` filter.** The `secrets.userId` column exists (added for
  personal inference keys) but nothing writes it for connectors. If a personal
  row with the same label appeared tomorrow, the map would keep whichever row
  came back last, and a task could mount one person's token as the team's. The
  same label-only lookup appears in the other files that read
  `mcp_connector_credential` (the callback, status, disconnect, refresh cron,
  block-notify cron, connector gate and pre-filter).
- **Tasks don't record a person.** `tasks.createdByAccountId` points at an
  `accounts` row, and accounts are API-key identities, not people
  (`docs/credentials-architecture.md`, "API-token model keys"). `missions`,
  `taskSchedules` and `conversations` do carry `createdByUserId`. Accounts don't
  record who created them: `POST /api/auth/device/approve` knows the approving
  user and doesn't store it on the account.
- **Runners see decrypted tokens.** The claim payload carries `headers`
  (`Authorization: Bearer …`) for each mounted connector. The runner keeps them
  out of the agent's environment (`docs/specs/credential-isolation.md` §3), but
  the runner process holds them, and a runner can be a team member's laptop.
- **Admin checks are team roles.** `teamMembers.role ∈ owner | admin | member`;
  helpers like `isTeamAdmin` (`apps/web/src/lib/migrate-access.ts`) gate writes.
- **Personal teams** are teams with slug `personal-{userId}`
  (`apps/web/src/lib/team-access.ts`).
- **Precedent for personal secrets exists.** `resolveInferenceKey`
  (`packages/core/inference-keys.ts`) serves a `userId` row only to its owner,
  and `SecretsProvider.list()` excludes personal rows
  (`packages/core/secrets/postgres-provider.ts`). This design reuses that shape.

## Proposal

### The crux

**Every agent run and every chat turn has exactly one acting person or none,
fixed when the work is created, and a personal credential resolves only for that
person.** The claiming runner doesn't choose, the connector doesn't choose, and
nothing falls through to "whoever connected last".

If this is wrong, the failure is the worst one in the design: Maya's Slack
token posts a message that Jonah's task wrote. Every other part (catalog,
policy, orgs) can ship late or ship rough. This part has to be right before the
first personal row is written, which is why step 0 below is a filter on
existing queries and not a feature.

### 1. Two identity modes per connector

A connector gets an `identityMode`:

| Mode | Credential used | When the acting person hasn't connected |
|---|---|---|
| `team` (default, today) | the team row, `userId IS NULL` | n/a |
| `personal` | the acting person's row | the connector is unavailable for this run |
| `personal_or_team` | the acting person's row if present, else the team row | the team row |

`personal` fits Gmail and calendar, where a shared identity makes no sense.
`personal_or_team` fits Slack and Linear: a bot identity by default, your own
identity once you connect. `team` fits Sentry and Vercel, where everyone should
see the same projects.

"Unavailable" plugs into the degraded-mode rules that already ship
(`docs/design/connector-availability-degraded-mode.md`): the connector is left
out and listed in `degradedConnectors` with a new failure mode
`personal_not_connected`, unless the task lists it in `requiredConnectors`, in
which case the task waits and the acting person gets a "Connect your Slack"
prompt. No other failure path exists.

### 2. Who the acting person is

`tasks.actingUserId` (nullable, new) is set once, at insert, by the first rule
that applies:

1. **Filed by a signed-in person** (dashboard, chat, `local_ui`): that person.
2. **Delegated sub-task** (`createdByWorkerId` set): the parent task's
   `actingUserId`. Delegation never switches identity.
3. **Spawned by a mission** (organizer or heartbeat): `missions.createdByUserId`.
4. **Spawned by a schedule**: `taskSchedules.createdByUserId`.
5. **Everything else** (API key, MCP from an agent with no parent, GitHub
   webhook, CI retry): `NULL`. These runs use team identity only.

`NULL` is safe: a `personal` connector just doesn't mount. Existing tasks keep
`NULL`, so nothing changes until someone files new work after a personal
credential exists. The task page shows the result ("Acts as Maya Okafor for
Slack, Linear; as the team for Sentry") so you can see it before a run starts.

The acting person must still be a member of the task's team at claim time. If
they left, their rows are gone (§6) and the connector behaves as "not
connected".

For chat, the acting person is the **author of the turn**
(`conversationMessages.authorUserId`), not the conversation's creator. A shared
conversation never lends one person's token to another person's question.

### 3. Consent

Connecting your own identity asks three things, and stores the answers in a
`connector_user_grants` row (policy only, no secret material):

- **Where it may be used.** `chat` (when I ask), `my_runs` (tasks I file),
  `standing_work` (missions and schedules I own, which run while I'm away).
  Default: `chat` and `my_runs`. `standing_work` is off until you tick it,
  because a 3am schedule posting as you is the case people get surprised by.
- **Which runners may hold it.** `own` (runners registered by you) or `team`
  (team-managed service runners, `accounts.type = 'service'`). Default `own`
  plus `team` for catalog entries marked `runnerSafe`; `own` only for custom
  connectors.
- **Which tools.** The catalog's default subset, which you can narrow but not
  widen.

A person's token never goes to a runner another person controls. That needs
`accounts.createdByUserId` (new, set at device approval, CLI login and
`POST /api/accounts`). Legacy accounts have `NULL` and count as "someone else's",
so they never receive personal tokens. The claim pre-filter
(`connector-prefilter.ts`) treats an ineligible runner like one missing a skill:
it skips the task and doesn't block it. If no eligible runner claims the task
within 15 minutes, the acting person gets one action-queue item ("Waiting for a
runner that can use your Slack") and no repeats until the state changes.

Revoking consent deletes the secret row, calls the provider's revocation
endpoint where one exists, and writes an audit event. A running worker that
already holds the token keeps it until the provider rejects it. Revocation at
the provider is the only thing that stops an in-flight run, so the UI says so.

### 4. Storage: still one `secrets` table

A personal connector credential is a `secrets` row with:

```
teamId      = connector.teamId      (the owner team, as today)
userId      = the person
accountId   = NULL
workspaceId = NULL
purpose     = 'mcp_connector_credential'
label       = connector.id
```

It uses the same encrypted `{ access_token, refresh_token }` blob and the same
optimistic-lock refresh in `refreshMcpConnectorCredential`, which already works
per row id. A partial unique index on `(teamId, userId, label) WHERE purpose =
'mcp_connector_credential' AND userId IS NOT NULL` keeps one personal row per
person per connector, mirroring `secrets_personal_inference_key_idx`.

Rules that keep personal rows personal:

- **Step 0 (load-bearing):** every existing read of `mcp_connector_credential`
  adds `userId IS NULL` before any code can write a personal row. A test seeds a
  personal row with the same label as the team row and checks that the claim,
  status, refresh, gate and notify paths all ignore it.
- Only the owner can read, replace or delete a personal row. Team admins see
  "3 of 7 members connected" and names, never a token, expiry detail or error
  text that might contain account details.
- The refresh sweep refreshes personal rows. `needsReconnect()` on a personal
  row alerts that person, not the team: `connector-block-notify` excludes
  personal rows from `notifyTeam` and sends a personal notification instead.
- The OAuth callback carries the connecting user in the signed `state`, and
  writes `userId` from that, never from a query parameter.

### 5. Catalog, marketplace and admin policy

**The catalog is code, not rows.** `packages/core/connector-catalog.ts` lists
reviewed entries. Each entry pins:

| Field | Meaning |
|---|---|
| `key` | stable id, e.g. `slack` |
| `url` | the vendor's hosted MCP endpoint |
| `oauth` | buildd's registered OAuth app for the vendor (client id in code, client secret in env), or `dcr` where the vendor supports dynamic registration |
| `scopes` | least-privilege scopes per identity mode |
| `tools` | the tool subset exposed, split per surface and classed `read` or `write` |
| `identityModes` | which modes the entry supports, and the default |
| `surfaces` | `runner`, `chat`, or both |
| `runnerSafe` | whether a personal token may ride on team service runners |

Installing a catalog entry creates an ordinary `connectors` row with a new
`catalogKey` column set. Injection, roles (`connectorRefs`), workspace
enablement and degraded mode work unchanged. A connector with
`catalogKey = NULL` is a custom connector, as every connector is today.

Starting catalog (scopes are a starting point; each entry's PR verifies them
against the vendor's current docs, and a CI probe checks the URL still answers
the MCP handshake):

| Connector | Default identity | Surfaces | Default tools | Scopes (least privilege) |
|---|---|---|---|---|
| Slack | `personal_or_team` | runner, chat | search messages, read channel/thread; write: post in thread, draft | user: `search:read`, `channels:history`, `groups:history`, `users:read`, `chat:write`; bot: `channels:history`, `chat:write` |
| Google Workspace (Gmail, Calendar, Drive) | `personal` | chat, runner | search/read mail, list events, read files; write: create draft | `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `drive.readonly` |
| Linear | `personal_or_team` | runner, chat | search/read issues; write: create issue, comment, change state | `read`, `write` (Linear has no narrower issue scope) |
| Jira / Confluence | `personal` | runner, chat | JQL search, read issue/page; write: comment, transition | `read:jira-work`, `write:jira-work`, `read:confluence-content.all` |
| GitHub | `team` via the existing GitHub App; `personal` optional | runner, chat | read issues/PRs/code; write: comment | App installation permissions as today; user-to-server token for personal |
| Notion | `personal` | runner, chat | search, read page; write: append to page | Notion's page picker at install is the scope |
| Vercel | `team` | chat, runner | list deployments, read build and runtime logs | read-only token scope |
| Sentry | `team` | chat, runner | list issues, read event, read stack trace | `org:read`, `project:read`, `event:read` |

Write tools start off in chat and on in runners. In chat every connector write
goes through an approval card (§7).

**Policy has three layers, and each can only narrow the one above it:**

1. **Org** (when the team has one): per catalog key `off | available | on`,
   plus `customConnectors: off | admins | members`. `on` installs one org-wide
   connector (§8) that every team sees.
2. **Team**: per catalog key `hidden | available`; a team can't show what the
   org turned off. Plus its own `customConnectors`, capped by the org's.
3. **Member**: picks from what's `available`: enables it for a workspace (any
   member can already do this through `PATCH /api/workspaces/[id]/connectors`)
   and connects their own identity where the mode allows.

Policy lives in a nullable `connectorPolicy` jsonb on `teams` (and on `orgs`,
§8). `NULL` means today: no catalog entry is hidden, custom connectors are
admin-only (what `POST /api/connectors` already enforces), and members see the
marketplace.

Turning a key `off` or `hidden` stops it mounting at the next claim and the next
chat turn, the same way a revoked share does (§1b AC-5). It doesn't delete
connector rows or credentials, so turning it back on restores them. Every
policy change writes an audit event.

### 6. Membership changes

- **A member leaves a team:** delete their personal rows for connectors owned
  by or visible to that team, revoke at the provider, and delete their grants.
  Runs already filed keep `actingUserId`, and the connector then behaves as
  "not connected".
- **A user is deleted:** the `secrets.userId` cascade already removes the rows;
  the leave path handles provider revocation first.
- **SCIM deprovision (P3):** runs the leave path for every team in the org and
  revokes runner accounts with `createdByUserId` = that user.

### 7. Runner connectors and chat connectors

A connector declares `surfaces`. Runner connectors mount through the claim
route as today. Chat connectors are called server-side from the chat route
through `createMCPClient`, with the turn author's identity or the conversation
team's team credential.

- **Chat requires `transport = 'http'`.** A stdio connector can't spawn a
  process in a serverless function, so the API rejects `surfaces` containing
  `chat` on a stdio connector.
- **Every chat-exposed connector tool is classified**, like the buildd actions
  in `apps/web/src/lib/chat/registry.ts`: `read` runs and shows a tool row;
  `write` needs an approval card naming the identity ("Post as Maya Okafor in
  #billing-launch"). An unclassified tool isn't offered. Catalog entries ship
  classified; custom connectors are read-only in chat until an admin classifies
  each write tool.
- **Connector tools declare reach** the way chat routes do in
  `reach-rules.ts` (#2854). The reach of a connector tool is an identity, not a
  workspace: `caller` (the turn author's own row) or `team` (the conversation
  team's row, for a connector that team owns, was shared, or sees org-wide). The
  guard refuses any other identity, and a CI test fails if a chat-exposed
  connector has no declaration. A sensitive workspace (`dataClass =
  'sensitive'`) never has its connector output pulled into a conversation.
- **Tool output is untrusted input.** It can at most lead the model to propose
  a write, and the write still needs the card (the prompt-injection rule in
  `agent-chat.md` applies unchanged).

### 8. The org layer

An org groups teams under one set of admins, one bill and one identity
provider. Teams stay the unit of work: workspaces, roles, missions and
connectors belong to teams as they do now.

```
org (optional) ── teams ── workspaces
  │                 └── team_members (owner | admin | member)
  ├── org_members (owner | admin | billing | member)
  ├── home team  (holds org-level secrets and org-wide connectors)
  ├── domains, SSO config, SCIM token (P3)
  └── connectorPolicy, budget
```

**Tables.** `orgs (id, name, slug, homeTeamId, connectorPolicy jsonb,
monthlyBudgetUsd, ssoConfig jsonb, createdAt, updatedAt)`, `org_members (orgId,
userId, role)`, `teams.orgId` (nullable). P3 adds `org_domains (orgId, domain,
verifiedAt)` and `org_group_mappings (orgId, externalGroupId, teamId, role)`.

**The home team.** `secrets.teamId` is required, and this design keeps it that
way. An org's secrets (org-wide connector credentials, the SSO client secret,
the SCIM bearer token) live on the org's home team, a normal team that the org
admins own. So `secrets` gets no `orgId`, the resolver keeps one precedence
chain, and org-level material sits behind the same encryption and access code
as everything else.

**Org-wide connectors.** A connector owned by the home team with a new
`visibility = 'org'` is visible to every team whose `orgId` matches the home
team's. Visibility becomes owned ∪ shared ∪ org-wide, and the existing
slug-collision rule still holds: an owned connector beats a shared one, which
beats an org-wide one. Credentials resolve by owner team, which §3 of the
connectors spec already requires, so injection needs no rewrite.

**Admins.** Org owners and admins manage policy, SSO, SCIM, billing and the
team list. They don't get implicit access to team workspaces: joining a team is
an explicit, audited action. `billing` sees invoices and spend only.

**Billing.** The org carries the invoice and a monthly cap. Each team's
existing `monthlyBudgetUsd` becomes a sub-cap that can't exceed the org's
remainder. Chat budgets (`chatDailyBudgetUsd`) stay per team.

**SSO and SCIM (P3).** Domain verification by DNS TXT record. OIDC first, SAML
second. When the org enforces SSO, sign-in for a verified domain goes through
the org's IdP, and a user with a verified-domain email can't join a team outside
the org without an org admin's approval. SCIM v2 `Users` provisions
`org_members`; `Groups` map to teams through `org_group_mappings`.

**Existing teams.** Every team today has `orgId = NULL` and behaves exactly as
now: team policy only, team billing, no org UI. A team owner creates an org from
Settings → Team; their team becomes the home team. They can attach other teams
they own. Attaching a team they don't own sends a request that the other team's
owner accepts. Personal teams (`personal-{userId}`) can't join an org. Detaching
a team drops org-wide connectors from its claims at the next claim, and drops
its members' personal rows for org-wide connectors.

### 9. Audit

`connector_events` is append-only: `(id, teamId, orgId, connectorId, event,
actorUserId, principal, taskId, workerId, runnerAccountId, conversationId,
tool, outcome, createdAt)`. `principal` is `team` or `user:<id>`. Events:
connect, disconnect, grant, revoke, policy change, mount (per claim, per
connector), chat tool call, denied (reach, consent or runner eligibility).

It never stores token values or tool arguments, which can contain message
bodies. You see every event for your own identity under Settings → You →
Connected accounts. Team admins see team-identity events, and for personal
identities they see who, which connector, which tool and which task, without
content. Org admins see policy events across teams.

### Safety properties

- A personal row resolves only for `actingUserId` or the turn author, and only
  on a runner that person controls or a team service runner they allowed.
  Violations fail closed: the connector doesn't mount.
- `actingUserId` is written once at insert and never updated.
- Policy and consent changes take effect at the next claim or turn; nothing
  retries or waits on them.
- The runner-eligibility wait alerts once per episode (15 minutes, then only
  on state change), deduped the same way as `expiryNotifiedAt`.
- Every new column defaults to today's behaviour: `identityMode = 'team'`,
  `surfaces = ['runner']`, `visibility = 'team'`, `catalogKey`, `orgId`,
  `connectorPolicy`, `actingUserId` and `createdByUserId` all `NULL`. Merging
  the schema changes nothing until someone installs a catalog entry or connects
  an identity.

## Implementation sketch

**P0: the filter.** No product change.
1. Add `userId IS NULL` to every team read of `mcp_connector_credential`, with
   the same-label personal-row test across claim, status, refresh, gate,
   pre-filter and both crons.
2. Add `tasks.actingUserId` and `accounts.createdByUserId` and populate them
   going forward (rules in §2, §3). Show "Acts as" on the task page.

**P1: catalog, team policy, personal identity for Slack, Linear and Notion.**
3. `connector-catalog.ts` with the eight entries; `connectors.catalogKey`,
   `identityMode`, `surfaces`, tool subsets. CI probe for catalog URLs.
4. Marketplace in Settings → Connectors: install, enable or hide per team,
   `teams.connectorPolicy`.
5. Personal connect flow with `connector_user_grants`, the unique index,
   callback `state` carrying the user, and runner eligibility in the
   pre-filter.
6. `connector_events` and the two audit views.
7. Chat read tools for Vercel and Sentry (team identity) and Slack search
   (caller identity), with reach declarations. Chat writes stay off.

Google Workspace follows once Google approves the restricted Gmail scopes for
buildd's OAuth app.

**P2: orgs.** `orgs`, `org_members`, `teams.orgId`, home team, org-wide
visibility, org policy caps, org billing roll-up, org admin overview.

**P3: SSO, SCIM, governance.** Domain verification, OIDC then SAML, SCIM,
custom-connector URL allowlist and a review queue for member-submitted custom
connectors, chat write tools behind approval cards.

## Open questions

1. **Should a mission's tasks act as the mission's creator?** I lean yes, gated
   on the `standing_work` consent, because a mission is that person's standing
   request. The alternative is team identity for every organizer-spawned task,
   which is safer but means a mission can never read your inbox.
2. **Can personal tokens ride on team service runners at all?** I lean yes for
   catalog entries marked `runnerSafe`, with consent, because otherwise
   personal connectors only work for people who run their own runner. The
   stricter option is personal tokens on the owner's own runners only.
3. **Home team vs `secrets.orgId`.** I lean home team: no change to `secrets`
   or its resolver. The cost is a team that exists partly as a container, and
   people will ask why it shows up in the team switcher.
4. **Org-wide visibility vs share rows.** Computing visibility from `orgId`
   avoids bookkeeping when teams join. Materialising `connector_shares` rows
   would reuse §1b exactly, but every attach and detach has to write them. I
   lean computed.
5. **Can a team hide an org-wide connector?** I lean yes, unless the org marks
   it locked, because a team working on regulated data may not want Slack
   mounted at all.
6. **Do org admins get read access to team content?** I lean no, with an
   audited "join team" action. Some buyers will want a read-only audit view
   instead.
7. **One OAuth app per vendor, or bring-your-own?** buildd's own app is the
   fast path. Larger orgs will want their own client id so their IdP policies
   apply. I lean buildd's app in P1 and an org-supplied client id in P3.
8. **Audit retention.** A year of `mount` events is the largest table here. I
   lean 90 days for `mount` and a year for everything else.

## Non-goals

- Domain-wide delegation or any admin acting as a user without that user's own
  OAuth grant.
- A public marketplace where third parties publish catalog entries.
- Per-workspace identity (a different Slack identity per workspace).
- Cross-org sharing. `connector_shares` stays within one org, or between
  standalone teams as today.
- Replacing the GitHub App. GitHub team identity stays the installation token.
- Rebuilding Slack or Discord as a chat *front end* (`chat-integrations.md`).
  This covers Slack as a tool the agent calls.

## Prototype

A static HTML prototype, kept outside the repo, shows four screens in dark and
light at desktop and phone widths: the team marketplace with on, available and
hidden controls per connector; Slack's detail page (whose account, which
surfaces use it, tool subset per surface, scopes, who connected, recent audit
events); a member's "Connect your Slack" consent sheet over a waiting task that
shows its "Acts as" line; and the org admin overview with a teams by connectors
availability matrix, team budgets and the sign-in panel. All names are
fictional (the Harborline demo team from
`scripts/demo/stories/multi-currency.json`).
