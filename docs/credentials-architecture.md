# Agent Credentials Architecture (SPEC)

> **Status: authoritative.** This is the pattern of record for storing any credential
> that a runner uses to authenticate an agent backend (Anthropic/Claude, OpenAI/Codex,
> and any future backend). Agents working in this repo **MUST** follow it. Do not
> introduce a new per-integration credential table — extend the unified model below.

## The rule

**All agent-backend credentials live in the single `secrets` table** with
team/account/workspace scoping. There is exactly one storage table and one scoping
model for credentials. New backends add a new `purpose`, not a new table.

❌ **Anti-pattern (do not do this):** a dedicated table like `codex_credentials`,
`anthropic_credentials`, `xyz_credentials` with its own `workspaceId` column and its
own CRUD. This was the original Codex implementation; it is being retired precisely
because it could not share one secret across workspaces and forced a parallel scoping
implementation. If you find yourself writing `pgTable('..._credentials', ...)`, stop.

## Why

- **One secret can cover all workspaces.** The `secrets` table already supports
  team-wide, account-wide, and workspace-scoped rows via nullable `accountId` /
  `workspaceId`. A team-wide row (`accountId = NULL, workspaceId = NULL`) is shared by
  every workspace in the team — the user connects once, not once per workspace.
- **One lookup/precedence implementation.** The claim route resolves credentials with a
  single fallback query. Parallel tables mean parallel (and divergent) lookup logic.
- **One UI.** Claude and Codex credentials are entered in one settings section with one
  scope selector, because they share one storage + scoping model.

## The `secrets` table

`packages/core/db/schema.ts` → `secrets`. Relevant columns:

| Column | Meaning |
|---|---|
| `teamId` | Required. The owning team. |
| `accountId` | Nullable. `NULL` = applies to all accounts in the team. |
| `workspaceId` | Nullable. `NULL` = applies to all workspaces in the team. |
| `purpose` | Discriminator: `anthropic_api_key`, `oauth_token`, `codex_credential`, `openai_api_key`, `mcp_credential`, `webhook_token`, `vercel_token`, `cloudflare_token`, `pushover`, `notify_webhook`, `pushover_personal`, `inference_key`, `decision_key`, `agent_endpoint`, `custom`. |
| `userId` | Nullable. A person's own key: `PERSONAL_SECRET_PURPOSES` in `packages/core/secrets/team-scope.ts` (`inference_key`, and `pushover_personal`, a person's Pushover user key for away-alerts; see `apps/web/src/lib/personal-pushover.ts`). `NULL` = not personal. A personal purpose is never read as a team credential, and an away-alert never falls back to the team's `pushover` row. See "API-token model keys". |
| `label` | Optional. For `mcp_credential` it is the env-var name. |
| `encryptedValue` | AES-256-GCM ciphertext. For multi-field credentials, encrypt a JSON blob (see Codex below). |
| `tokenExpiresAt` | Nullable. Set for token credentials that expire (`codex_credential`, `oauth_token`). Enables efficient "expiring soon" cron queries. |
| `lastRefreshedAt` | Nullable. Set for token credentials that auto-refresh. Doubles as the optimistic-lock column for refresh (see below). |

### Scoping precedence (most specific wins)

When resolving a credential for a task in workspace `W` (team `T`) claimed by account `A`:

```
SELECT ... FROM secrets
WHERE teamId = T
  AND purpose = :purpose
  AND (accountId IS NULL OR accountId = A)
  AND (workspaceId IS NULL OR workspaceId = W)
```

Then pick the **most specific** match:

1. `workspaceId = W` (workspace-specific)
2. `accountId = A`, `workspaceId IS NULL` (account-wide)
3. `accountId IS NULL`, `workspaceId IS NULL` (team-wide)

For single-valued credentials (one Codex login per scope) the resolver returns the single
most-specific row. The claim route already applies the team/account/workspace filter for
`anthropic_api_key` / `oauth_token` / `mcp_credential`; `codex_credential` uses the same
filter plus the precedence pick.

### Who may write a shared credential

Writing or deleting a team-wide, workspace-wide or account-wide credential
requires a named team permission (`docs/specs/team-permissions.md`), resolved
through `can()` so a team's permission overrides apply:

- `manage_team_model_keys` — `inference_key`, `decision_key`, `cloudflare_token`.
- `manage_team_credentials` — every other purpose `/api/secrets` stores, and the
  workspace Claude/Codex connect, OAuth/device-login and delete routes.

Both default to owner and admin, and to an admin-level API key. `/api/secrets`
never writes a personal (`userId`) row, so a plain member writes nothing there.
A `workspaceId` in the body must belong to the target team. Listing stays open
to members (metadata only, never values). Refreshing an existing Claude/Codex
credential rotates it in place and stays open to any member of the team.

### API-token model keys (chat, inference, decision calls)

Server-side model calls spend a metered API key, never a subscription seat. They
resolve it through one function, `resolveInferenceKey` in
`packages/core/inference-keys.ts`, from `inference_key` rows (provider in `label`:
`anthropic`, `openai`, `openrouter`), plus `anthropic_api_key` for Anthropic and the
legacy `decision_key` for OpenRouter. So one OpenRouter key serves chat and decisions.

**LiteLLM gateway.** An `inference_key` row labelled `litellm`, team-wide
(optionally per workspace; never personal), holds an encrypted JSON blob
`{ "apiKey", "baseUrl" }` for an OpenAI-compatible proxy
(`packages/core/litellm-gateway.ts`, Settings → Model providers). Chat and
`inferenceCall` use it only when the tier's provider has no key (chat tries
OpenRouter first), sending the model as `provider/model`. Decision calls use it
when `teams.decision_model` says `via: 'litellm'`. The key policy binds it like
any shared key: under `own` it does not resolve.

These rows add a **user** dimension: `secrets.userId` (nullable) marks a person's own
key. `accountId` can't hold it, because accounts are API-key identities, not people.
Precedence is caller-first, since the person asking is the one paying:

1. `userId = U` (the caller's own key; never served to anyone else)
2. `accountId = A` (the calling API account, as decision calls always did)
3. `workspaceId = W`
4. team-wide (`userId`, `accountId`, `workspaceId` all NULL)
5. a legacy account-scoped row, only for callers with no account (cron paths)
6. the provider env var, only when `NODE_ENV !== 'production'` or
   `BUILDD_ALLOW_ENV_INFERENCE_KEYS=1` (self-hosting)

Personal rows are excluded from `SecretsProvider.list()`, so no team-wide list or
delete path reaches them. They're managed through `/api/inference-keys` (personal
scope for any member, team scope for owners/admins), which returns only the last
four characters and health, never plaintext.

### Agent model endpoint

`purpose = 'agent_endpoint'`, team-wide or one workspace (never account or
personal). Encrypted JSON: `{ "kind": "gateway" }` (a reference to the team's
LiteLLM row above; its root minus `/v1`) or `{ "kind": "openrouter" |
"anthropic-compatible", "baseUrl", "apiKey", "authHeader", "models"? }`.
`resolveAgentModelRoute` in `packages/core/agent-endpoint.ts` ranks it against
`anthropic_api_key` / `oauth_token` / `claude_credential`: workspace > account >
team, a tie to the endpoint, only the winner delivered. The key policy does not
bind it. Design: `docs/design/agent-model-endpoint.md`.

**Protocol capabilities** ride on the same blob: `"capabilities": {
"toolSearch"?: boolean }`, either kind. `toolSearch` is Claude's deferred
MCP/tool loading (ToolSearch + `tool_reference` blocks), which Claude Code
switches off by itself for any non-Anthropic `ANTHROPIC_BASE_URL`. The
effective value (`effectiveToolSearch`) is the explicit one when set, else the
kind's default: `openrouter` on (it supports the semantics; `false` is the
escape hatch), `gateway` and `anthropic-compatible` off (a LiteLLM deployment or
custom proxy may not pass them through). It resolves per row, so a workspace
row carries its own value and the winner's is what the claim sends
(`modelEndpoint.toolSearch`, Claude tasks only). The runner then sets
`ENABLE_TOOL_SEARCH=true` in that run's env (`applyModelEnv`) and deletes it on
every other path; it is not in `RUNNER_ENV_PASSTHROUGH`, so one runner can
serve endpoints that differ. Codex is unaffected. Not yet applied on cloud
runs: the container talks to `api.anthropic.com` and egress rewrites it, so
Claude Code there keeps its Anthropic default.

**The same row also routes Codex tasks**, for a `kind` that has an
OpenAI-compatible wire in addition to its Anthropic one: `gateway` (LiteLLM
speaks both off the same base) and `openrouter` (its native wire *is* OpenAI
chat-completions) both do; `anthropic-compatible` doesn't — it's a
self-contained proxy that promises only the Anthropic Messages API, so there's
no OpenAI-format route to guess at. `resolveEndpointFromBlob` computes this as
`AgentEndpointRoute.openAiBaseUrl` (present only for the two OpenAI-compatible
kinds).

Ranking for a Codex task calls `resolveAgentModelRoute({ ..., backend: 'codex'
})`, which competes the endpoint against `openai_api_key` / `codex_credential`
instead of the Anthropic purposes — the credentials a Codex run would
otherwise use, same shape (most specific scope wins, tie to the endpoint). The
claim (`attachAgentEndpoints`) attaches `modelEndpoint` to a Codex worker the
same way it does for Claude, including when the endpoint has no
`openAiBaseUrl`: the worker still gets it, specifically so the runner can fail
the task with a clear message (`agent-model-env.ts`'s `applyModelEnv`, surfaced
as `ModelEnvResult.error`) instead of silently falling back to local Codex
auth as if no endpoint had been configured.

The runner applies it as `OPENAI_BASE_URL` = `openAiBaseUrl`, `OPENAI_API_KEY`
= the endpoint key — Codex's `authHeader` is always effectively Bearer (the
OpenAI wire has no `x-api-key` concept), so that field is ignored on this path.
A per-machine override works the same way the Claude path's `LLM_PROVIDER`
does: a runner whose machine already has `OPENAI_BASE_URL` set reports
`codexBaseUrlOverride: true` on the claim, the server withholds the endpoint
key (`modelEndpointIgnored`), and the runner's own `OPENAI_BASE_URL` /
`OPENAI_API_KEY` are left untouched. `OPENAI_BASE_URL` had to be added to
`RUNNER_ENV_PASSTHROUGH` (`apps/runner/src/agent-env.ts`) for this override to
actually reach the agent subprocess at all — it previously wasn't allowlisted.

Capability gating (the claim route's `capability_mismatch` filter,
`backend-failover.ts`'s `isBackendConfigured`) treats an OpenAI-compatible
agent endpoint as "Codex is configured" exactly like `hasCodexCredential` /
`hasOpenAiApiKey` — via `hasOpenAiCompatibleAgentEndpoint`, a cheap existence
check (endpoint resolves and has `openAiBaseUrl`), not the full ranking. The
claim-time check additionally requires the runner to have declared
`AGENT_ENDPOINT_RUNNER_FEATURE`, since a runner that hasn't would never
actually apply `modelEndpoint` and the task would then fail at spawn with no
credential at all.

Cloud-runner support for Codex through the endpoint remains out of scope
(`POST /api/runner/model-endpoint` still 404s a Codex task outright) — this is
the host-runner path only.

### Cloud egress precedence vs the operator's `MODEL_PROXY_URL`

A host runner has no concept of an operator proxy override: it just sends
whichever Anthropic credential resolves. The cloud dispatcher does have one
(`MODEL_PROXY_URL`, a Worker secret — apps/cloud-runner/README.md "Model
routes"), and for a while that silently won even when a team had its own
`anthropic_api_key` configured: `POST /api/runner/model-endpoint` only ever
resolved the `agent_endpoint` side of the ranking, so a task whose winner was
the plain API key got a 404 and egress fell through past the key straight to
`MODEL_PROXY_URL` or AI Gateway. A team that paid for its own key never spent
it on a cloud run.

The route now also calls `resolveAnthropicAuth`
(`apps/web/src/lib/claude-credential.ts` — the same resolver server-side
Anthropic calls use, scoped exactly as the self-hosted runner resolves it) when
the `agent_endpoint` ranking does not win, and returns the key, flagged
`{ source: 'anthropic_api_key', key }`, when that resolver's winner is a plain
API key. `resolveModelRoute` in `apps/cloud-runner/src/outbound.ts` checks that
flag ahead of `MODEL_PROXY_URL`:

- **A team's own `anthropic_api_key` beats `MODEL_PROXY_URL`.** Storing a key
  is not an opt-in to route agents through anything — unlike `agent_endpoint`,
  where setting one is exactly that opt-in — so an operator's Worker-level
  proxy pin must not silently spend the team's own credential on a different
  route. This is the one precedence flip relative to how `agent_endpoint` and
  `MODEL_PROXY_URL` have always ranked.
- **`agent_endpoint` vs `MODEL_PROXY_URL` is unchanged**: the operator override
  still wins, so a self-hosted deployment that pins a Worker to one proxy keeps
  doing so "whatever team claims through it" regardless of any `agent_endpoint`
  a team configured.
- **An OAuth seat or Claude credential winning the ranking is still 404.**
  Cloud egress carries only a metered key or an `agent_endpoint`, never a seat
  token — that stays a documented gap, not a silent one.
- The lookup itself now runs whenever the local `ALLOW_DIRECT_ANTHROPIC` escape
  hatch does not apply, even with `MODEL_PROXY_URL` set — previously the Worker
  skipped it outright in that case, since nothing could have outranked the
  override. A transient failure of that lookup (`'unavailable'`) still defers
  to `MODEL_PROXY_URL` or refuses, exactly as it did before the key existed; it
  never counts as "confirmed, no team key" the way a real 404 does.

## The runner machine's own model login

A self-hosted runner whose machine has its own Claude login gives that login to
its agents. "Its own login" means `CLAUDE_CODE_OAUTH_TOKEN` in the runner's
environment (on `RUNNER_ENV_PASSTHROUGH`, `apps/runner/src/agent-env.ts`) or a
`claude login` under the runner user's `$HOME`; a stub `~/.claude.json` does not
count. Detection and precedence: `applyHostSeatPolicy` in
`apps/runner/src/host-seat.ts`, then `applyModelEnv` /
`shouldUseClaudeCredential` in `apps/runner/src/agent-model-env.ts`.

Against a subscription seat delivered on the claim (`oauth_token`,
`claude_credential`), `BUILDD_HOST_SEAT` on the runner decides:

- unset / `auto`: the machine's login when the claim delivers no stored seat;
  otherwise the stored seat, with the agent env exactly as it was before the
  passthrough existed.
- `prefer`: the machine's login wins.
- `off`: the machine's env token never reaches the agent.

In every mode:

- A delivered metered key (`anthropic_api_key`) still fills an unset
  `ANTHROPIC_API_KEY`.
- A team agent model endpoint or a non-Anthropic base URL replaces the login;
  a seat never goes to a third-party host.
- Codex tasks follow the same modes with the machine's `codex login`
  (`$CODEX_HOME`, else `~/.codex`; `decideCodexSeat` in `host-seat.ts`). The
  per-worker Codex home links `auth.json` to it (`linkMachineCodexAuth` in
  `codex-auth.ts`), and a delivered credential is never written through the
  link. `prefer` beats a stored ChatGPT login, never a team `openai_api_key`.
  No tokens are written back to buildd from a machine-login session.
- The value is never logged and is exact-value redacted from worker output.

Setup per environment (local, service, container): `apps/runner/README.md`,
"Model login on the runner machine".

## Multi-field credentials (Codex)

`secrets.encryptedValue` holds a single string, so a credential with several fields is
stored as an **encrypted JSON blob**:

```jsonc
// plaintext, before encrypt() — purpose = 'codex_credential'
{ "access_token": "...", "refresh_token": "...", "account_id": "..." }
```

- `tokenExpiresAt` and `lastRefreshedAt` are stored as **real columns** (not inside the
  blob) so the refresh cron can query expiry in SQL and the refresh lock can be atomic.
- `account_id` is not secret but lives in the blob for atomicity; surface it to the UI by
  decrypting (status endpoint).

**Input normalization.** `normalizeCodexAuthJson()` accepts what the user actually pastes:
the raw `~/.codex/auth.json` (credential fields nested under a `tokens` object) **or** an
already-flat object. Expiry is resolved from explicit `expires_in` / `expiry`, else decoded
from the access-token JWT `exp` claim; if none is derivable the credential is still stored
with no expiry. Keep this normalization **server-side** — never push format-wrangling (jq,
JWT base64url decoding, clipboard tools) into the UI, where it rots across CLI versions and
operating systems.

### Token refresh + rotation lock

OpenAI rotates the refresh token on every use, so a refresh must always persist the new
refresh token. Concurrency is controlled with a DB-level optimistic lock on
`lastRefreshedAt`:

```
UPDATE secrets
   SET lastRefreshedAt = NOW()
 WHERE id = :id
   AND (lastRefreshedAt IS NULL OR lastRefreshedAt < NOW() - INTERVAL '60 minutes')
RETURNING *
```

Only the caller whose `UPDATE ... RETURNING` returns a row holds the lock and performs the
network refresh; concurrent callers get `locked`. This is the same pattern the retired
`codex_credentials` table used — preserved, just keyed off `secrets`.

> Per CLAUDE.md, do **not** use `db.transaction()` with the neon-http driver. The atomic
> `UPDATE ... WHERE ... RETURNING` above is the locking mechanism.

## Cloudflare API token (cloud runner)

`purpose = 'cloudflare_token'`, one team-wide row (`accountId`, `workspaceId`,
`userId` all NULL). `encryptedValue` is JSON `{ apiToken, accountId, aiGatewayId? }`,
validated and normalized by `parseCloudflareCredential`
(`apps/web/src/lib/cloudflare-credential-shared.ts`) before it is encrypted.
Set and delete through `/api/secrets` (`manage_team_model_keys`: team owner/admin by default, or an admin API key);
`POST /api/secrets/[id]/verify` checks it against Cloudflare's token-verify
endpoints and records `lastVerifiedAt` / health (a rejection marks it
`revoked`, a network error leaves health alone). `GET /api/cloudflare/credential`
returns masked metadata only.

The token is **used** without being handed out: deployment actions
(docs/specs/deployment-actions.md) resolve it server-side by credential
reference (the row's label, or `cloudflare` when unlabelled) and call
Cloudflare themselves, returning a redacted result. A Platform Operator task
reaches them through the `deploy` MCP action under its workspace grant
(docs/specs/agent-capabilities.md); a person with an admin key through
`POST /api/deployments`. Every call is audited in `deployment_audit_events`.

`POST /api/cloudflare/credential/reveal` is the one route that returns a
stored value, the `secrets:reveal` escape hatch: `bld_` admin API keys only,
own team only, `no-store`, audited as elevated before it decrypts. Its one
remaining caller is the container-image `wrangler deploy` step of
`apps/cloud-runner/scripts/deploy.ts`. The token is never sent to a runner.

## OpenAI API key for Codex agent tasks (`openai_api_key`)

`purpose = 'openai_api_key'`, a plain raw string, scoped team/account/workspace
exactly like `anthropic_api_key`. This is **not** the same credential as
`inference_key` (label `openai`), and **not** the same purpose as
`codex_credential` — both already existed, and this backend reuses neither:

- **Why not reuse `inference_key`/`openai`?** That row serves chat and decision
  calls only (`resolveInferenceKey` in `packages/core/inference-keys.ts`), with
  its own precedence (caller → account → workspace → team, plus a personal
  `userId` dimension — see "API-token model keys" above). Routing it into
  Codex subprocess auth too would mean either a second, divergent resolver
  reading the same purpose for a different consumer, or bending its
  chat-oriented precedence to fit agent-task scoping. A credential that
  authenticates a CLI subprocess is not the same thing as a key that pays for
  one inference call, even though both happen to be OpenAI keys.
- **Why not just extend `codex_credential`?** `codex_credential` already
  accepts a plain API key as one of its two credential shapes (the other being
  the ChatGPT OAuth blob) — see "Multi-field credentials (Codex)" above. But
  storing it means going through the Codex OAuth-connect UI/route family
  (`/api/workspaces/[id]/codex-credential/*`, a JSON blob with its own
  normalization), which is overkill for a team that just wants to paste a key
  the way they already do for Anthropic. `openai_api_key` is that simpler path
  through the generic `/api/secrets` route, with the same `RAW_STRING_PURPOSES`
  quote-stripping and `REQUIRED_PREFIXES` sanity check as `anthropic_api_key`.

**Resolution order:** `attachCodexCredentials` (claim route) tries
`resolveCodexCredential` (`codex_credential`) first — an existing ChatGPT
connect, OAuth or legacy API-key blob, wins if present — and falls back to
`resolveOpenAiApiKey` (`openai_api_key`) only when nothing resolves there.
Either one is synthesized into the exact same `codexCredential: { credentialType:
'api_key', apiKey }` wire shape the runner already materializes into
`auth.json` (`writeCodexApiKeyToHome` in `apps/runner/src/codex-auth.ts`) — so
the runner needed **no changes** to accept it. `hasCodexCredential` (capability
gating, budget failover, dashboard readiness) is likewise paired with
`hasOpenAiApiKey` at every call site (`apps/web/src/app/api/workers/claim/route.ts`,
`apps/web/src/lib/backend-failover.ts`): either credential is enough to make
Codex configured for a team/workspace. See `apps/web/src/lib/openai-credential.ts`.

**Cloud-runner support is out of scope** — `attachCodexCredentials` only feeds
the self-hosted-runner claim path; `apps/cloud-runner` has no Codex execution
today.

## Adding a new backend (checklist)

1. Add a `purpose` value to `SecretPurpose` in `packages/core/secrets/types.ts` **and** the
   `secrets.purpose` `$type<...>` union in `packages/core/db/schema.ts`. (Both are text —
   no DB enum migration needed for the purpose itself.)
2. If the credential has multiple fields, store an encrypted JSON blob in `encryptedValue`.
3. If it expires/refreshes, set `tokenExpiresAt` / `lastRefreshedAt` and reuse the refresh
   lock pattern above.
4. Resolve it in the claim route using the scoping precedence query — do not add a new
   lookup path.
5. Surface it in the unified Agent Backends settings section with the shared scope selector
   (default: all workspaces / team-wide).
6. **Do not create a new table.**

## Files

- Schema: `packages/core/db/schema.ts` (`secrets`)
- Provider: `packages/core/secrets/` (`postgres-provider.ts`, `types.ts`)
- Codex helper (blob + refresh): `apps/web/src/lib/codex-credential.ts`
- OpenAI API key helper (plain key, no refresh): `apps/web/src/lib/openai-credential.ts`
- Claim-time resolution: `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/workers/claim/credential-injection.ts`
- Refresh cron: `apps/web/src/app/api/cron/codex-token-refresh/route.ts`
- Settings UI: `apps/web/src/app/app/(protected)/settings/` (Agent Backends section)
