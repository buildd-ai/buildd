# Subscription auth as a self-host-only capability

**Status:** Proposed
**Related:** `docs/credentials-architecture.md`, `docs/specs/auth-oauth-boundaries.md`, `docs/specs/credential-refresh-lifecycle.md`, `docs/specs/codex-backend-spec.md`, `docs/design/runner-oauth-broker.md`, `docs/design/user-owned-agent-credentials.md`, `docs/design/backend-failover-policy.md`, `packages/core/backend-policy.ts`, `packages/core/db/schema.ts`, `apps/web/src/app/api/secrets/route.ts`, `apps/web/src/app/api/workers/claim/credential-injection.ts`, `apps/runner/src/broker.ts`

> Scope note: this is an architectural capability boundary and a deployment-topology
> decision — self-hosted operators bring their own subscription credentials; a hosted
> multi-tenant product bills metered API usage. The commercial/risk analysis that
> motivates the boundary is recorded in the private knowledge-base risk register and
> deliberately not restated here.

## Problem

buildd today has exactly one build. `apps/web` is a single Next.js app
(`apps/web/package.json`), `packages/core` is exported as raw TypeScript source
(`packages/core/package.json` `exports` map), and every capability in the tree is
present in every deployment of it. There is no edition, no build variant, and no
`BUILDD_EDITION`-shaped input anywhere in the repo — `grep -rn "self-host"` over
tracked sources returns four hits, all prose (`README.md:111`, `README.md:134`,
`docs/testing-strategy.md:167`, `apps/web/src/lib/app-url.ts:12`).

Subscription-shaped agent-backend auth is not a corner of that build. It is the
**default**:

- A dashboard signup creates its account with `authType: 'oauth'` —
  `apps/web/src/auth.ts:170`.
- `POST /api/accounts` defaults the same way: `authType: authType as 'api' | 'oauth' || 'oauth'`
  — `apps/web/src/app/api/accounts/route.ts:84`.
- The `codex` backend has exactly one credential purpose and it is a subscription
  one: `credentialPurposes: ['codex_credential']` —
  `packages/core/backend-policy.ts:59`. There is no metered OpenAI purpose in the
  tree at all (`openrouter_credential` at `backend-policy.ts:73` is a comment-only
  placeholder with `dispatchable: false` and no `SecretPurpose` value).
- The only multi-tenant credential path that exists decrypts a *tenant's own*
  subscription token out of task context and injects it as
  `CLAUDE_CODE_OAUTH_TOKEN` — `packages/core/tenant-crypto.ts:9`,
  `apps/runner/src/workers.ts:2101-2109`.

So "ship a hosted multi-tenant build that cannot do subscription auth" is not a
matter of hiding a settings card. The capability is load-bearing in the account
defaults, the backend registry, the claim path, the runner, the budget model, and
the only multi-tenancy design the repo has. Nothing today prevents a hosted
deployment from accepting a pasted subscription credential, storing it, leasing
it to a runner, and refreshing it on a cron.

## Current state

Surveyed with `file:line` citations so the blast radius is arguable rather than
asserted. **It is large**, and §7 phases accordingly.

### Boundary-relevant storage

| Thing | Where | What it actually is |
|---|---|---|
| `accounts.authType` `'api' \| 'oauth'` | `packages/core/db/schema.ts:116`, index `:153` | A **billing/limits mode**, not a credential. Every account has a hashed `apiKey` (`schema.ts:111`) regardless. `'oauth'` selects `maxConcurrentSessions`/`activeSessions`/`budgetExhaustedAt` (`:127-132`); `'api'` selects `maxCostPerDay`/`totalCost` (`:119-120`). |
| `secrets.purpose` | `packages/core/db/schema.ts:1961` (13-value `$type` union over a plain `text` column) | The actual agent-backend credential material. |
| `secrets.oauth_token` | prefix-validated `sk-ant-oat` at `apps/web/src/app/api/secrets/route.ts:36` | Legacy raw Claude OAuth setup token. No refresh token. |
| `secrets.claude_credential` | `apps/web/src/lib/claude-credential.ts:28` (`PURPOSE`) | JSON blob from an interactive Claude OAuth login (access + refresh + expiry). |
| `secrets.codex_credential` | `apps/web/src/lib/codex-credential.ts`, normalizer `:91` | `auth.json` blob from a ChatGPT device/interactive login. |
| `secrets.anthropic_api_key` | prefix-validated `sk-ant-api` at `apps/web/src/app/api/secrets/route.ts:37` | Metered. |
| `accounts.oauthToken` | `packages/core/db/schema.ts:123` | Deprecated plaintext column, still readable. |
| `credentialLeases` | `packages/core/db/schema.ts:2399-2412` | Runner-held lease over one `secrets` row. Exists only to serialize subscription-token rotation. |
| `oauthBudgetEpisodes` | `packages/core/db/schema.ts:2528-2553` | Learned 5h-window capacity. Meaningless without a plan window. |
| `tenantBudgets` | `packages/core/db/schema.ts:2474-2484` | Per-tenant subscription exhaustion (the multi-tenant path). |
| `tasks.context.tenantContext.encryptedOauthToken` | `packages/core/tenant-crypto.ts:21-27`; duplicated at `apps/runner/src/tenant-crypto.ts:3` | A subscription credential that **never touches `secrets`**. A purpose-based guard misses it entirely. |

### Write and read boundaries for credentials

| Surface | Path | Note |
|---|---|---|
| Generic secret write | `apps/web/src/app/api/secrets/route.ts:107-110` | Already has a `validPurposes` allowlist → the natural single hook. |
| MCP `manage_secrets` | `packages/core/mcp-tools.ts:2759`, POST at `:2777-2786` | Passes `purpose` straight through to `/api/secrets`, so it **inherits** any guard there. Registered at `mcp-tools.ts:193` (admin-gated). |
| Claude credential CRUD | `apps/web/src/app/api/workspaces/[id]/claude-credential/route.ts`, `/oauth/start`, `/oauth/exchange`, `/refresh` | Bypasses `/api/secrets`. |
| Codex credential CRUD | `apps/web/src/app/api/workspaces/[id]/codex-credential/` — `route.ts`, `device/start`, `device/poll`, `refresh`, `verify`, `write-back` | Bypasses `/api/secrets`. |
| Runner lease | `apps/web/src/app/api/runner/credential-lease/route.ts` | `acquire\|heartbeat\|release`; steal-only-if-expired `INSERT … ON CONFLICT … WHERE expires_at < NOW() RETURNING` at `:65-81`. |
| Runner refresh | `apps/web/src/app/api/runner/credential-refresh/route.ts` | `lock\|commit\|release\|revoke\|bootstrap` (`:323-326`). The canonical optimistic lock is the `UPDATE secrets … WHERE refreshLockedAt IS NULL OR refreshLockedAt < NOW() - INTERVAL '60 minutes' … .returning()` at `:150-174`. |
| Refresh crons | `apps/web/src/app/api/cron/codex-token-refresh/route.ts`, `apps/web/src/app/api/cron/lease-expiry-guard/route.ts` | Declared in `cron-manifest.json` (`0 */4 * * *` and the guard). Both observe-only unless `BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true`. |
| Claim-time injection | `apps/web/src/app/api/workers/claim/credential-injection.ts` | `attachServerManagedSecrets:33` (purpose filter at `:54`, `oauth_token` pick at `:82`), `attachCodexCredentials:127`, `attachClaudeCredentials:182`, `attachPendingCredentialRefreshes:228` (`:125` purpose filter). |

### `authType` branches

`grep -rn authType` over tracked `.ts`/`.tsx`: **~56 files**, of which 15 are
non-test. The decision sites:

- `apps/web/src/app/api/workers/claim/route.ts:174` (api → `maxCostPerDay` 429),
  `:188` (oauth → `maxConcurrentSessions` 429), `:203-218` (budget auto-clear
  across `seatId` peers), `:235` (ambiguous multi-workspace OAuth reject),
  `:258` (`accountBudgetExhausted`), `:659` (`dailyBudgetPct` for api),
  `:683` (OAuth pacing), `:1628` (`activeSessions` increment).
- `apps/web/src/lib/stale-workers.ts:487-491`, `:586`, `:836` — OAuth-scoped
  session decrements.
- `apps/web/src/lib/pacing-stall.ts:57` (api daily-cap pct) vs `:63` (oauth pressure).
- `apps/web/src/app/api/accounts/me/route.ts:27`, `apps/web/src/app/api/tasks/[id]/start/route.ts:32-72`
  (its own local `'api' | 'session'`), `apps/web/src/app/api/mcp/route.ts:257`,
  `packages/core/mcp-tools.ts:718`.

### Runner side

| Module | Verdict |
|---|---|
| `apps/runner/src/claude-auth.ts` (92 lines) | **100% subscription.** `buildClaudeCredentialsFile:14`, `materializeClaudeConfigDir:57`, `cleanupClaudeConfigDir:85`. No API-key branch. |
| `apps/runner/src/broker.ts` (484 lines) | **100% subscription.** Lease endpoint `:81-83`, refresh endpoint `:85-87`, unix-socket token server `:126-188`, `tryAcquireLease:202`, `bootstrapCredential:241`, `heartbeatAll:272`, `refreshExpiring:295`, `shutdown:333`, `fetchTokenFromBroker:462`. |
| `apps/runner/src/credential-refresh.ts` (229 lines) | **100% subscription.** Hardcoded provider token URLs `:19-20`; `runnerRefreshCredential:40`. |
| `apps/runner/src/codex-auth.ts` (336 lines) | **Mixed.** OAuth arm at `writeCodexAuthJson:100-109` and the `idToken` preflight `:92-97`; `checkCodexCredentialExpiry:180`. API-key arm (`writeCodexApiKeyToHome:119`) and all MCP/home plumbing survive. |
| `apps/runner/src/workers.ts` | **Mixed, ~15 sites.** Metered fallback `cleanEnv.ANTHROPIC_API_KEY = worker.serverApiKey` at `:2084`. Subscription: `CLAUDE_CODE_OAUTH_TOKEN` inject `:2089-2095`, tenant decrypt `:2098-2109`, broker-first managed-token block `:2296-2347`, Codex oauth arm `:2159-2165`, expiry preflight `:2354-2361`. |
| `apps/runner/src/backends/codex-backend.ts` | `resolveAuth` returns `type: 'oauth'` at `:334` and `:336`; deleting those two lines leaves the `api_key` + `OPENAI_API_KEY` path intact (`:333`, `:335`, `:342-343`). |
| `apps/runner/src/claim-breaker.ts` | Subscription-semantics classification: `:35-54`, seat session cap `:74`, `OAuth budget exhausted` → 60min pause `:102-103`. |
| `apps/runner/src/credential-cache.ts` | Halves — the `oauthToken` field goes, the `apiKey` field stays (`ServerCredential:23`). |

Runner totals: **11 production files** need edits or deletion; **13 test files
(~3,074 lines)** are premised on subscription auth and **25 more** reference it
incidentally (env fixtures, the bwrap mount-allowlist snapshot,
`apps/runner/__tests__/unit/read-jail.test.ts:165` asserting the `claude-cfg-`
mkdtemp prefix).

### Seat billing, budget forecasting, pacing

| Module | Role | Importers |
|---|---|---|
| `packages/core/oauth-budget.ts` | Pure window-capacity learner. `OAUTH_WINDOW_MS:30` (5h), `readPacingConfig:57` (`OAUTH_BUDGET_PACING`), `MODEL_WEIGHTS:91`, `learnOauthCapacity:187` (p25 over ≤10 episodes, inert under 3), `oauthBudgetPressure:235`, `inferWindowStart:293`, `windowEndsAt:319` | 5 production + 3 tests |
| `apps/web/src/lib/oauth-budget-window.ts` | DB half. `resolveSeatIdPeers:27`, `loadOauthEpisodes:58`, `measureOauthWindow:100` | 5 production |
| `apps/web/src/lib/budget-forecast.ts` | Mixes seat forecasting with dollar forecasting in one module. `groupOauthAccountsBySeatId:198`, `getBudgetForecast:215`, OAuth session loop `:315-362`, Codex/tenant block `:270`, `:391-404` | 3 production + 4 tests |
| `packages/core/model-router.ts` | **The only place subscription pressure changes behaviour.** `dailyBudgetPct` input `:35`, thresholds `:120` (≥0.95 → `paused`), `:132`, `:139` | — |
| `apps/web/src/lib/pacing-stall.ts` | Watchdog probe: `max(api daily-cap pct, learned oauth pressure)` `:55-84` | `apps/web/src/app/api/cron/queue-stall/route.ts:78` |
| `get_budget_forecast` | MCP action. Registered in `workerActions` at `packages/core/mcp-tools.ts:177`; description advertising `startAfter: "budget_reset"` at `:383`; handler `:3190-3243`; backing route `apps/web/src/app/api/health/budget/route.ts` | 3 production + 1 test |
| `seatId` | `packages/core/db/schema.ts:126`, index `:154`. Written at `apps/web/src/lib/claude-credential.ts:205-210` (JWT `sub`), `apps/web/src/app/api/oauth/token/route.ts:66-72`, `apps/web/src/app/api/accounts/route.ts:96-109`, `apps/web/src/app/api/workers/[id]/route.ts:1338-1352`. Backfill `scripts/backfill-seat-ids.ts` | 13 production + 5 tests |

Exit-cause and pacing surfaces keyed to subscription limits: `budget_limited` in
the `exitCause` union (`packages/core/db/schema.ts:1351`,
`packages/shared/src/types.ts:635`), classified at
`apps/web/src/lib/worker-exit-taxonomy.ts:69` and
`apps/web/src/lib/failure-classifier.ts:20`, retry-cap-exempt at
`apps/web/src/lib/stale-workers.ts:181` and
`apps/web/src/lib/worker-exit-taxonomy.ts:128`; `startAfter` whose union is
*only* `'budget_reset'` (`apps/web/src/lib/deferred-start.ts:55`), resolved off
`accounts.budgetResetsAt` at `apps/web/src/app/api/tasks/route.ts:289`; runner
report `rateLimitType` with a `'five_hour'` default at
`apps/runner/src/workers.ts:4189`.

`budget_exhausted` needs splitting, because the raw grep overstates it: **66
files** mention it, but `MissionStatus`'s `budget_exhausted`
(`packages/core/mission-helpers.ts:841`) is a **mission dollar budget** written
only by `apps/web/src/lib/mission-budget.ts:24-56`. A hosted build keeps that.
The subscription slice is just `accounts.budgetExhaustedAt`/`budgetResetsAt`,
`tenantBudgets`, and the write block at
`apps/web/src/app/api/workers/[id]/route.ts:1275-1380`.

### UI

`apps/web/src/app/app/(protected)/settings/AgentBackendsSection.tsx` (1,550
lines) is the collection surface: Claude purpose toggle `oauth_token` vs
`anthropic_api_key` at `:563`, `:585`, `:718`; OAuth authorization-code connect
at `:864`; `CodexCard` at `:1199-1500` with device login `:1257` and `auth.json`
paste `:1302`. Display surfaces:
`apps/web/src/app/app/(protected)/health/HealthClient.tsx:472-474`, `:1829-1831`
(purpose labels), `BudgetForecastSection` `:1650-1663`;
`apps/web/src/app/app/(protected)/health/usage/UsageClient.tsx:114` (cost is
absent, not approximate, under seat auth);
`apps/web/src/app/app/(protected)/workspaces/[id]/connect-runner.tsx:202`,
`:267`, `:286` (`CLAUDE_CODE_OAUTH_TOKEN` in the copy-paste GitHub Actions
recipe).

### Tests

**~37 files** reference `oauth_token`/`claude_credential`/`codex_credential`/
`authType='oauth'`/`seatId`; **30 more** assume subscription budget exists. The
two heaviest are `apps/web/src/app/api/workers/claim/route.test.ts` (70
`authType` references) and `apps/web/src/app/api/workers/[id]/route.test.ts`
(37).

### Honest total

Roughly **60–70 non-test production files**, **6 route trees**, **4 DB tables /
8 columns**, **2 duplicated modules** (`tenant-crypto.ts` exists twice —
`packages/core/tenant-crypto.ts` and `apps/runner/src/tenant-crypto.ts:3`, and
the core copy has **no importer**, so deleting one does not delete the
capability), and **~60 test files**. This is a multi-release programme, not a
PR. §7 splits it so that every phase is independently shippable and every phase
before the last is a no-op for existing deployments.

## Proposal

### 1. The boundary definition

Three unrelated things in this codebase share the word "oauth". Fixing the
vocabulary is prerequisite work, because an ambiguous boundary makes every later
guard ambiguous:

1. `accounts.authType = 'oauth'` — a **billing mode** on a buildd account.
2. `secrets.purpose = 'oauth_token'` — a **provider subscription credential**.
3. `/api/oauth/authorize|token|register` — **buildd's own OAuth provider**, which
   mints buildd tokens for MCP clients (`docs/specs/oauth-provider-and-jwks.md`).
   This is entirely out of scope and must not be touched.

**Definition.** A credential is **subscription auth** iff redeeming it draws on a
seat/plan entitlement rather than a metered balance. The mechanical test, chosen
because it is checkable in code rather than requiring judgement:

> A credential is subscription auth iff it is obtained by an **interactive
> end-user login** (authorization-code/PKCE or device-code) **or** carries a
> refresh token / expiry that a provider rotates.

Applying it:

- **Subscription:** `claude_credential`, `codex_credential`, `oauth_token`, and
  `tasks.context.tenantContext.encryptedOauthToken`.
- **Metered:** `anthropic_api_key`, `inference_key`, and a future
  `openrouter_credential`.
- **Neither (unaffected):** `mcp_credential`, `mcp_connector_credential`,
  `webhook_token`, `vercel_token`, `signing_key`, `pushover`, `notify_webhook`,
  `custom`.

`oauth_token` is the awkward case: a raw `sk-ant-oat…` string with no refresh
token, so the second clause does not catch it — but it is minted by an
interactive login, so the first does. Classified **subscription**. (Open
question 5.)

**Deliverable:** `SUBSCRIPTION_PURPOSES` and `METERED_PURPOSES` as exported
frozen sets derived from `BACKEND_REGISTRY` in `packages/core/backend-policy.ts`,
so the registry stays the single source of truth and a new backend cannot be
added without landing on one side of the line. Rename in **types and prose only**
(`plan_credential` / `metered_credential`); the DB string values stay, because
renaming them is a data migration for zero behavioural gain.

### 2. Mechanism comparison

**The crux: is the hosted boundary a route-inventory boundary or a conditional?**
Everything below turns on it. Under `app/api/**` a route *file* is the endpoint —
Next.js maps the filesystem to the URL space and there is no supported way to
tree-shake a route handler out of a build. A handler that exists answers, and the
only question is what it answers with. So "the hosted build cannot accept a
subscription credential" is achievable as `404 by absence` only if the file is
not in the hosted tree. If that premise is wrong — if hosted and self-host must
remain one artifact for operational reasons — this design collapses to option A
and the honest conclusion is "a flag is the best available control and the
residual risk is accepted."

| Option | What it is | What it does NOT protect against | Who can flip it |
|---|---|---|---|
| **A. Runtime feature flag** | `BUILDD_SUBSCRIPTION_AUTH`, checked at each site. Precedent: `BUILDD_ALLOW_CONTROL_PLANE_REFRESH` (`apps/web/src/app/api/workspaces/[id]/claude-credential/refresh/route.ts:33` — fail-closed, default off) and `OAUTH_BUDGET_PACING` (`packages/core/oauth-budget.ts:57` — fail-open, default on) | The code is still in the artifact. A **mis-default** — and note the current defaults are already the subscription ones, hardcoded in two places (`apps/web/src/auth.ts:170`, `apps/web/src/app/api/accounts/route.ts:84`), so the flag must *invert* an existing default. A **forgotten check** on a new path — there are ~15 non-test `authType` decision sites plus a `tenantContext` path that never reads `secrets` at all. A reviewer approving `?? true` | Anyone with Vercel project env access, with no deploy; anyone who lands a PR touching the default; anyone who adds a code path |
| **B. Separate package** | `@buildd/subscription-auth`, absent from `apps/web`'s `dependencies` in the hosted build | Someone re-adding the dependency (needs a manifest gate); DB rows already at rest; the **duplicated** `apps/runner/src/tenant-crypto.ts` copy, which is not in any package | Anyone who edits `apps/web/package.json` — but that is a reviewable diff in the artifact's own manifest, not an env var |
| **C. Build-time exclusion in one package** | Conditional import / define-replacement in `apps/web/next.config.mjs` | Route files: see the crux. You cannot exclude `app/api/**/route.ts` from a Next build; the file's presence *is* the endpoint. Degenerates into B (move the files) or a prebuild prune step | Whoever controls the build env — same weakness as A, plus non-obviousness |
| **D. Separate deployment artifact** | Two Next apps, shared `packages/*` | Nothing, at the cost of duplicating the dashboard and doubling the CI/deploy surface. Also does not by itself stop the hosted DB holding subscription rows | Only a deploy |

**Recommendation: B + A + a CI gate, in that order of authority.**

1. **B is the boundary.** The subscription capability moves into a package the
   hosted app does not depend on, and the subscription-only route trees move out
   of the hosted route inventory. Absence is the property; everything else is
   defence in depth.
2. **A is defence in depth, fail-closed.** `BUILDD_SUBSCRIPTION_AUTH` guards the
   *shared* sites that cannot move out of the hosted tree — the `/api/secrets`
   write boundary, the claim-time injector, and the runner's `tenant-crypto`
   read. Default must be **off**, following `BUILDD_ALLOW_CONTROL_PLANE_REFRESH`
   and not `OAUTH_BUDGET_PACING`: a missing env var must mean "no subscription
   auth", so a fresh hosted deploy is safe before anyone configures anything.
   (Phase 1 ships it defaulted *on* so merging is a no-op per
   DESIGN-FORMAT rule 2; the polarity flips in Phase 3 when the hosted edition
   actually exists.)
3. **The gate makes both auditable** (§6).

**Reject A alone.** A flag leaves an operational, decrypting, cron-refreshing
subscription-credential subsystem inside the hosted artifact, one env-var edit
away from live, with ~15 branch sites and one path (`tenantContext`) that a
purpose-based check cannot see. "Who can flip it" is the decisive column: under A
the answer is "anyone with Vercel env access, silently, without a deploy or a
diff." Under B it is "anyone who lands a visible change to the hosted app's
dependency manifest," which is exactly the kind of change a CI gate can fail.

**Reject C** on the crux. **Defer D**: it is strictly stronger than B but the
cost is a duplicated dashboard, and B's route-inventory step already delivers
most of D's value. Revisit if Phase 3 proves a single Next app cannot express two
route inventories (open question 1).

### 3. Fail-closed behaviour

Hiding UI is not the requirement. A hosted instance must **refuse to accept or
store** subscription credential material, by every route in.

| Ingress | Hosted behaviour | Mechanism |
|---|---|---|
| `POST /api/secrets` with `purpose: 'claude_credential'` | `400` naming the boundary: *"subscription credentials are a self-hosted capability; this deployment accepts metered API keys only"* | Drop those purposes from `validPurposes` (`apps/web/src/app/api/secrets/route.ts:107-110`) |
| MCP `manage_secrets` `action: 'set'` | Same `400`, surfaced as a tool error | Inherited — the handler POSTs to `/api/secrets` (`packages/core/mcp-tools.ts:2777-2786`) and adds no storage path of its own. **Verify this stays true**; it is the one place a future refactor could route around the guard |
| `POST /api/workspaces/[id]/claude-credential`, `…/codex-credential`, `…/oauth/start`, `…/device/start` | `404` — the route does not exist | Route file absent from the hosted inventory (Phase 3) |
| `POST /api/runner/credential-lease`, `/api/runner/credential-refresh` | `404` | Same |
| `GET /api/cron/codex-token-refresh`, `/api/cron/lease-expiry-guard` | Not in `cron-manifest.json` for hosted, and `404` | Same. Note `cron-manifest.json` is a single shared file — see open question 2 |
| A task arriving with `context.tenantContext.encryptedOauthToken` | Task rejected at write with an explanatory error; runner refuses to decrypt | Write-boundary validation on `tasks.context` + guard at `apps/runner/src/workers.ts:2101` |
| A `secrets` row that predates the split | Never decrypted, never leased, never injected | See below |

**Data already at rest is the hard part.** Three options:

- *(i) Leave it and let claim-time injection skip it.* Rejected: silent. Workers
  start with no credential and fail with an auth error that names the wrong
  cause.
- *(ii) Delete it in a migration.* Irreversible, and per CLAUDE.md a migration
  that joins real tables against a hardcoded list of observed values is itself
  the disclosure hazard in a public repo. Not a first move.
- *(iii) Mark, refuse, surface, then delete.* **Recommended.** One migration sets
  `healthStatus = 'revoked'` on rows whose `purpose` is in
  `SUBSCRIPTION_PURPOSES` (column exists: `packages/core/db/schema.ts:2004`, and
  `credential-injection.ts:77-80` already deprioritises `revoked`), the injector
  refuses them outright rather than deprioritising, and
  `HealthClient.tsx:472-474` already has the label to show them. A hard delete
  follows one release later, once operators have seen the state.

**`accounts.authType` rows at rest are a separate footgun and must not be
hand-waved.** Flipping a hosted account from `'oauth'` to `'api'` moves it from
the `maxConcurrentSessions` gate (`claim/route.ts:188`) to the `maxCostPerDay`
gate (`:174`) — and `maxCostPerDay` is **nullable** (`schema.ts:119`), so the
`if (account.maxCostPerDay && …)` guard is falsy and the account becomes
**uncapped**. Any migration that flips `authType` must set a cap in the same
statement. Open question 4 is what that cap should be.

### 4. The data boundary

**Yes — a hosted database should be structurally incapable of holding
subscription credentials**, and the repo has the precedent for enforcing it at
the write boundary rather than at read time:
`validateGoalCriteria` in `packages/core/mission-helpers.ts:173-181` rejects a
`metric` goal criterion at POST with an error explaining *why* and naming the
alternative, rather than storing it and letting `evaluateGoalCriteria` return
UNVERIFIED forever (`:409-412`). Same shape here: reject the purpose, say the
capability is self-host-only, name the metered alternative.

Three layers, weakest to strongest:

1. **Application allowlist.** `validPurposes` at
   `apps/web/src/app/api/secrets/route.ts:107` minus `SUBSCRIPTION_PURPOSES`.
   One line, and it already exists as an allowlist rather than a denylist, which
   is the correct polarity — a new subscription purpose is excluded by default.
2. **Postgres `CHECK` constraint** on `secrets.purpose`. `purpose` is plain
   `text` with a TypeScript-only `$type` union (`schema.ts:1961`), so the DB
   accepts anything today. A hosted-only constraint is the one control that also
   binds a direct `psql` write, a seed script, and a future code path that forgets
   the allowlist. But `packages/core/drizzle/` is a **single shared migration
   channel** — a hosted-only constraint has no home in it. Open question 2.
3. **Encryption-key partition.** Hosted's `ENCRYPTION_KEY` never having
   encrypted a subscription credential means a leaked hosted DB cannot yield one
   even if a row appears. This falls out of the split for free and is worth
   stating as an invariant rather than building.

`validateGoalCriteria` also carries the pattern's essential escape hatch — its
`opts.stored` grandfathering (`mission-helpers.ts:127-145`) exists precisely so a
tightened write boundary does not brick the only editor that could fix the
offending row. The credential equivalent: a hosted instance must still be able to
**DELETE** a pre-split subscription row through `DELETE /api/secrets`, even
though it can no longer POST one. A guard that blocks both is a guard that
strands the data it was meant to remove.

### 5. What the hosted product loses, and the replacement

| Capability | Surface | Hosted replacement | Verdict |
|---|---|---|---|
| Claude via subscription | `secrets.claude_credential` / `oauth_token`, `apps/runner/src/workers.ts:2089`, `:2296-2347` | `anthropic_api_key` → `worker.serverApiKey` → `cleanEnv.ANTHROPIC_API_KEY` (`workers.ts:2084`) | **Already exists and is the more reliable path.** Clean swap |
| **Codex backend** | `credentialPurposes: ['codex_credential']` (`packages/core/backend-policy.ts:59`) — its *only* purpose | None. No metered OpenAI purpose exists in the tree | **Disappears entirely from hosted.** Must be removed from `BackendSelect`, `MissionBackendSelector`, and the `agent_backend` choices — not merely left to fail |
| Codex as failover target | `failoverCandidates:172`, `pickFailoverBackend:209` (`backend-policy.ts`) | Single-candidate list; `resolveFailoverBackend` returns `not_configured` (`:222`) | **Degrades to nothing.** `docs/design/backend-failover-policy.md` needs a hosted section |
| Seat billing | `maxConcurrentSessions`/`activeSessions` (`schema.ts:127-128`), `claim/route.ts:188`, `:1628` | `maxCostPerDay` + `monthlyBudgetUsd`, both already implemented (`claim/route.ts:174`) | Clean swap |
| Session-limit pacing | `claim/route.ts:683`, `oauth-budget-window.ts`, `pacing-stall.ts:63` | The `dailyBudgetPct` path at `claim/route.ts:659` feeds the **same** `model-router.ts` thresholds (`:120`, `:132`, `:139`) | **Degrades cleanly** — the router is indifferent to how pressure was computed |
| Window-capacity forecasting | `packages/core/oauth-budget.ts` (`learnOauthCapacity:187`), `oauth_budget_episodes`, the OAuth half of `getBudgetForecast:315-362`, `get_budget_forecast` | Cost-based forecast from `totalCost` / `monthlyBudgetUsd` (`computeMonthlyBudgetForecast:94` already exists) | **Genuinely disappears.** A metered balance has no 5h window, so "pressure within the current window, resets in 2h" has no analogue. `get_budget_forecast` keeps the monthly and mission blocks and loses the session block |
| `startAfter: 'budget_reset'` | `apps/web/src/lib/deferred-start.ts:55` — the union's *only* member; resolved off `accounts.budgetResetsAt` (`tasks/route.ts:289`) | None | **Must be rejected at the write boundary** in hosted, or every deferred task waits on a reset that never arrives. Advertised in the MCP schema at `mcp-tools.ts:351`, `:383` — that string has to change too |
| `budget_limited` exit cause | `worker-exit-taxonomy.ts:69`, `failure-classifier.ts:20`, retry-exempt at `stale-workers.ts:181` | Metered spend caps can produce their own limit error | **Keep the cause**, re-point the classifier. The retry exemption (`worker-exit-taxonomy.ts:128`) stays correct either way |
| `budget_exhausted` mission state | `mission-helpers.ts:841` | Unchanged — this is the **mission dollar budget**, written by `mission-budget.ts:24-56` | **Keep.** Only `accounts.budgetExhaustedAt` and `tenantBudgets` are subscription-shaped |
| **Multi-tenant BYO credential** | `packages/core/tenant-crypto.ts`, `tenantBudgets` (`schema.ts:2474`), `workers.ts:2098-2109`, `workers/[id]/route.ts:1300-1315` | Nothing today | **This is the sharpest finding.** The only multi-tenant credential story the repo has is tenants supplying their own *subscription* tokens. A metered-only hosted product needs tenant BYO-**API-key** designed and built. That is a **prerequisite for hosted existing at all**, not a consequence of this split |

### 6. Enforcement gate

A gate at `scripts/hosted-capability-boundary.test.ts` — `scripts/` is already a
collected root (`scripts/run-unit-tests.ts:16`), so no registration step, and
`scripts/collector-coverage.test.ts` enforces that it is actually collected.

House pattern, from `apps/runner/__tests__/unit/cbm-version-pin.test.ts`:

- Locate files `REPO_ROOT`-relative via `import.meta.dir` + a hop count, never
  `process.cwd()` (`cbm-version-pin.test.ts:15-17`). Reads at module scope, so a
  **moved file throws during collection** rather than skipping a test.
- A `match()` helper that throws `pattern not found: <regex>` when its anchor
  disappears (`:19-23`) — so a renamed symbol fails loudly instead of asserting
  `undefined === undefined`.
- Exhaustive `toEqual` over a sorted literal set, not `toContain` (`:41-49`), so
  an *extra* entry fails as loudly as a missing one.
- Cardinality **and** distinctness (`:57-59`), with an inline comment stating what
  the gate cannot prove and which other check covers it (`:52-56`).

Checks, in hosted mode:

1. `apps/web/package.json` `dependencies` does not contain
   `@buildd/subscription-auth`. Exhaustive `toEqual` on the sorted dependency
   key list so an addition fails, not just a removal.
2. The hosted route inventory, read from **`git ls-files`** (precedent:
   `scripts/skills-listed.test.ts` reads git rather than the filesystem, so a
   local untracked file cannot make the gate pass or fail for everyone else),
   contains none of the subscription route trees.
3. `validPurposes` in `apps/web/src/app/api/secrets/route.ts` intersects
   `SUBSCRIPTION_PURPOSES` in the empty set.
4. Every backend in `DISPATCHABLE_BACKENDS` (`backend-policy.ts:81`) has at least
   one purpose in `METERED_PURPOSES` — this is what catches "someone made Codex
   dispatchable in hosted again."
5. **Post-build artifact scan.** After `cd apps/web && bun run build:only`
   (`.github/workflows/build.yml:177`), grep the `.next/server` output for
   `CLAUDE_CODE_OAUTH_TOKEN`, `sk-ant-oat`, `platform.claude.com/v1/oauth/token`,
   `auth.openai.com/oauth/token`, `TENANT_MASTER_KEY`. Source-only assertions
   cannot see a transitive import; this one can.

**How someone proves this gate works.** This repo has a long, documented history
of gates that were green while measuring nothing — `bun test` exiting 0 having run
almost no files, orphaned test directories nothing collected, a `vars.` reference
that made the no-prod-data scan match an empty pattern on every PR
(`.github/workflows/no-prod-data.yml:14-19`). So this section is load-bearing, and
each mechanism below is already used somewhere in the tree:

1. **A negative self-test inside the gate.** `.github/workflows/build.yml:39-63`
   does exactly this for the workflow-name linter: it synthesizes a *violating*
   fixture, asserts the checker rejects it, and emits
   `Self-test passed: linter correctly identifies missing name: ✓` before
   checking the real tree. The boundary gate does the same — construct an
   in-memory manifest that names `@buildd/subscription-auth`, run the predicate,
   assert it fails. A typo'd glob then fails the self-test instead of silently
   matching zero files.
2. **Non-empty assertions.** Assert `SUBSCRIPTION_PURPOSES.size > 0` and that the
   route walk examined `>= N` files. Green-over-empty-set is the specific
   recorded failure class.
3. **A documented live-violation recipe**, recorded in this doc so a future
   reader can re-run it: add `import '@buildd/subscription-auth'` to one hosted
   route, run `bun run scripts/run-unit-tests.ts scripts/hosted-capability-boundary.test.ts`,
   confirm red, revert. The expected failure text goes in the test's doc comment.
4. **An explicit statement of what the gate cannot prove**, per
   `cbm-version-pin.test.ts:52-56`: it proves absence from the artifact **CI
   built**, not from the artifact Vercel is currently serving. The covering
   control for that is the runtime fail-closed guard (§2 item 2) plus the
   deploy-time env contract (`bun run env:verify`, `build.yml:82`) — named here so
   nobody mistakes the gate for end-to-end proof.

### 7. Migration and rollout phases

Five phases. Every phase is independently shippable, independently revertible,
and every phase before 3 is a **no-op for all existing deployments**.

**Phase 0 — Vocabulary and registry. No behaviour change.**
Add `SUBSCRIPTION_PURPOSES` / `METERED_PURPOSES` to
`packages/core/backend-policy.ts`, derived from `BACKEND_REGISTRY` so a new
backend cannot dodge the classification. Update
`docs/credentials-architecture.md`'s new-backend checklist to require picking a
side. Fix the three-way "oauth" vocabulary collision in prose and types.
Revert: delete the constants. *One PR.*

**Phase 1 — Runtime guard, defaulted ON so merging changes nothing.**
`BUILDD_SUBSCRIPTION_AUTH` (absent ⇒ enabled, for now) guarding the
`/api/secrets` write boundary, the dedicated credential routes,
`credential-injection.ts`, and the runner's `tenant-crypto` read. Tests assert
**both** polarities, following
`apps/web/src/app/api/workspaces/[id]/claude-credential/refresh/route.test.ts:56`,
`:83`, `:111`. Revert: delete the checks. *One PR.*

**Phase 2 — Package extraction. Still one artifact.**
Create `@buildd/subscription-auth` and move `apps/web/src/lib/claude-credential.ts`,
`codex-credential.ts`, `codex-device-auth.ts`, `claude-oauth-login.ts`,
`packages/core/oauth-budget.ts`, `packages/core/tenant-crypto.ts`,
`apps/runner/src/broker.ts`, `credential-refresh.ts`, `claude-auth.ts`, and the
OAuth arms of `codex-auth.ts`. Delete the duplicate
`apps/runner/src/tenant-crypto.ts` in favour of the package. Split
`budget-forecast.ts` along its existing seam (seat forecasting vs dollar
forecasting) — that split is worth doing on its own merits. Routes stay in place
and import from the package. Revert: it is a move; `git revert` restores it.
*3–5 PRs.* This is where the seat/`authType` branch sites get an interface
instead of an inline conditional.

**Phase 3 — The hosted edition. The hard phase.**
Introduce the hosted route inventory, remove the subscription route trees from
it, drop the dependency, land the §6 gate, and **flip the Phase-1 flag default to
off**. This is the phase that actually creates a second artifact and the one whose
mechanism is unresolved (open question 1) — it may require a second Next app,
i.e. option D. Nothing before this point commits to the answer, which is the
point of the ordering. *Unknown size; scope it after open question 1 closes.*

**Phase 4 — Data boundary.**
Purposes rejected at the hosted write boundary; `CHECK` constraint if open
question 2 resolves; at-rest sweep (`healthStatus = 'revoked'` → refuse
injection → surface in health UI → hard delete one release later); `authType`
migration **with a cap set in the same statement** (§3). *2–3 PRs.*

**Phase 5 — Replacement features. A product project, not a refactor.**
Tenant BYO-API-key (the prerequisite from §5); metered budget forecast replacing
the session block of `get_budget_forecast`; `startAfter` rejected in hosted with
its MCP description updated; Codex removed from hosted backend selection;
`docs/design/backend-failover-policy.md` given a hosted section. *Multiple PRs;
tenant BYO-API-key deserves its own design doc.*

## Open questions

1. **One Next app or two?** Route-file absence is the only way to get 404-by-
   absence, and Next has no supported per-build route exclusion. Candidates: a
   second `apps/web-hosted` that re-exports shared route modules; a prebuild
   prune keyed on `BUILDD_EDITION`; option D outright. I lean **prebuild prune
   with the §6 gate asserting the pruned inventory**, because it keeps one
   dashboard — but a prune step is a build-time mutation, which is exactly the
   class of thing this repo has been burned by, so I would not defend it hard.
   **This is the question that decides Phase 3's size and I am not deciding it
   alone.**
2. **Do hosted and self-host share `packages/core/drizzle/`?** A hosted-only
   `CHECK` constraint has no home in a single shared migration channel. Options:
   a conditional migration keyed on a DB setting (fragile, and the schema-drift
   gate would see it as untracked DDL); a second migration channel (a lot of
   machinery); or drop layer 2 of §4 and rely on the application allowlist plus
   the encryption-key partition. I lean **drop layer 2 for now** and revisit if
   a bypass is ever observed.
3. **Does self-host keep multi-tenancy?** The boundary as defined is a property
   of the *deployment* ("this operator owns the subscription"), not of a team. If
   a self-hoster runs several teams for several people, are they a hosted
   multi-tenant operator in the sense this design excludes? I lean "the edition
   is the operator's declaration and buildd does not police it," but that makes
   the edition flag advisory for third parties, which is worth saying out loud.
4. **What is hosted's default `maxCostPerDay`?** Required by §3 — flipping
   `authType` without one produces an uncapped account. A product decision, not
   an engineering one.
5. **Is `oauth_token` subscription or legacy-metered?** No refresh token, raw
   string, minted by an interactive login. I lean subscription. If it were
   classified metered, the §4 allowlist gets simpler and the at-rest sweep gets
   smaller — which is precisely why I distrust that answer.
6. **Does `openrouter` become hosted's failover target?** It is
   `dispatchable: false` with a `credentialPurposes` value that has no
   `SecretPurpose` member (`backend-policy.ts:68-75`). Making it real would give
   hosted a second backend and restore failover. Attractive, but it is a separate
   project and should not be smuggled in as a dependency of this one.
7. **Who owns the edition input — build env or a DB row?** I lean **build env**:
   a DB row is flippable by anyone with DB access, silently, which reproduces
   option A's weakness at a layer with even less review.
8. **Is `BUILDD_EDITION` public-facing?** Self-hosters read
   `docs.buildd.dev`. If it is documented, it is also a thing people set wrong;
   if it is not, self-hosters cannot tell which edition they are running. I lean
   documented, defaulting to self-host, with the hosted value set only by the
   hosted deploy.
9. **Does the runner need an edition?** Today every runner is operator-run by
   definition (`docs/specs/credential-isolation.md` assumes it). A hosted product
   implies buildd-operated runners, which is a different trust model and a
   different design doc. Phases 0–4 assume runners stay operator-run.
10. **Can the gate ever check the deployed artifact?** §6 check 5 inspects CI's
    build. Whether a post-deploy probe against the live deployment is worth
    building, or whether the env contract is sufficient, is open.

## Non-goals

- **Not implementing anything.** No flags, no moved code, no new packages in
  this PR.
- **Not designing hosted billing, pricing, or metering.** §5 names
  `maxCostPerDay` / `monthlyBudgetUsd` as the existing replacement mechanisms and
  stops there.
- **Not designing buildd-operated runners** (open question 9).
- **Not changing self-hosted behaviour.** Self-host keeps the full capability,
  unchanged, at every phase.
- **Not touching buildd's own OAuth provider** (`/api/oauth/*`,
  `docs/specs/oauth-provider-and-jwks.md`). Same word, unrelated subsystem —
  see §1.
- **Not tenant BYO-API-key.** Named as a prerequisite in §5 and Phase 5; it needs
  its own design doc.
- **No vendor-terms analysis.** Out of scope here by design; see the private
  knowledge-base risk register.
