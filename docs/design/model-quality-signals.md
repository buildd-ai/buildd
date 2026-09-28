# Model quality signals: Artificial Analysis as a routing prior

**Status:** Proposed (Q1 implemented: the pure scoring core —
`packages/core/model-quality.ts` — landed ahead of the fetch/mapping/schema
units it depends on for real data. Q2–Q11, including the AA fetch, the id
mapping, the cron step and the wiring into `tier-explore.ts`'s posterior,
remain proposed. Nothing calls this module yet, so it changes no routing.)
**Amends:** `docs/design/tier-weights.md` (§2 suggested weight and its price source, §4a/§4c prior terms, §4b succession, §5 evidence). It adds a third external signal to the machinery that doc defines and does not add a parallel one. Where the two disagree on AA, this doc wins. On everything else, tier-weights wins.
**Related:** `docs/design/tier-weights.md`, `docs/design/tier-model-pools.md`, `packages/core/tier-pool.ts` (`MIN_GRADED_UNITS`, `QUALITY_BY_SEVERITY`, `summarizeArm`), `packages/core/tier-pool-admin.ts`, `packages/core/model-catalog.ts` (`CatalogEntry`, `normalizeCatalog`, `priceFromCatalog`, `modelFamily`, `snapshotBase`, `vendorOf`, `TIER_PRICE_BANDS`), `packages/core/model-catalog-cache.ts` (`getCachedOpenRouterCatalog`), `packages/core/model-prices.ts`, `packages/core/inference-keys.ts`, `packages/core/secrets/types.ts`, `packages/core/secrets/team-scope.ts`, `packages/core/mcp-tools.ts` (`manage_secrets`), `packages/core/db/schema.ts` (`secrets`, `tierPools`, `tierPoolArms`, `tierPoolChanges`, `modelTierRegistry.defaultEffort`), `apps/web/src/app/api/inference-keys/route.ts`, `apps/web/src/components/settings/ProviderKeyCard.tsx`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.tsx`, `cron-manifest.json`. Upstream contract: the Artificial Analysis OpenAPI document served at `https://artificialanalysis.ai/api/v2/openapi` (OpenAPI 3.1, generated from their Zod contract). Every field name below is taken from it.

---

## Problem

The tier-weights design gives buildd two outside facts to act on: OpenRouter
rankings, which measure **adoption**, and the catalog, which supplies
**release order and price**. Neither measures whether a model is any good at
the work a pool serves. Three things go wrong as a result:

1. **A new arm starts blind.** A challenger enters `explore` with
   `Beta(1, 1)` plus at most 4 popularity pseudo-units. A model that scores 20
   points higher than the incumbent on a public agentic benchmark and a model
   that scores 20 points lower get the same starting belief, apart from how many
   people happen to use them.
2. **Succession trusts version numbers alone.** `findSuccessor` (tier-weights
   §4b) treats `sonnet-5 → sonnet-5-1` as an upgrade because `[5,1] > [5]`.
   When a vendor ships a newer point release that is cheaper and weaker, which
   happens with "flash" refreshes, the pool adds it as an auto-challenger and
   starts decaying the older, better arm. Decay only halts after both arms clear
   learning. That is weeks of traffic on the weaker model.
3. **The add sheet shows a price and nothing else.** An admin choosing a
   challenger sees `$in / $out`, a context length and a release date. The one
   question they are actually asking, "is this model any good at coding or
   chat?", has to be answered in another browser tab.

Artificial Analysis (AA) publishes independent composite indexes, per-benchmark
scores, pricing and measured latency for most models we can route to, through
a keyed API with a free tier. This doc specifies how that data becomes a
**quality signal inside the tier-weights machinery**: a bounded prior, a
succession check, a price fallback and one compact UI row. It stays a prior.
It is sized so that our own graded outcomes dominate once an arm has
`MIN_GRADED_UNITS`, and its weight is cut automatically if it stops predicting
those outcomes.

## Current state

| Piece | Where | What this doc does with it |
|---|---|---|
| Popularity prior | tier-weights §4a: at most 4 pseudo-units, `m ∈ [0.45, 0.55]`, stored in `system_cache` per team and view, never re-served | AA is added as a second prior term of the same form (§5). |
| Signal combination | tier-weights §4c: evidence, then popularity, then stage caps, then succession/expiry caps, then harm cut. Counterfactual attribution. Popularity never triggers a change. | AA is inserted as step 2b. It gets the same "never triggers" rule (§5c). |
| Succession | tier-weights §4b `findSuccessor` (W6), decay `0.5^(days/14)`, halted by evidence | AA adds a quality veto on the *automatic* path only (§5d). |
| Suggested weight | tier-weights §2 `suggestWeight`: blended `(3·in + out)/4` from the OpenRouter catalog, `> 1.25×` → `low`, else `med`, unknown → `low` | The catalog stays the price source. AA is the fallback. Quality can lower `med` to `low` but never raise anything (§6). |
| Catalog | `normalizeCatalog` keeps `id`, `canonicalId`, `openRouterId`. W6 adds `permaslug`. | The join target for AA ids (§2). |
| Arm identity | `tier_pool_arms (route, model)`, with no effort column. Effort comes from `model_tier_registry.default_effort`. | Effort-aware mapping (§2c). |
| Credentials | `secrets` table; `SecretPurpose` in `packages/core/secrets/types.ts`. There is no purpose for a data-source key. | Adds purpose `data_api_key` (§1d). |
| Cron | `/api/cron/tier-pools` is built by tier-weights W7, and the rankings step is added in W8. | The AA fetch is one more step in that cron (§3b). |
| AA data | none | Everything below. |

## Proposal

### The crux

**AA is evidence about models in general, not about our work. It may shape
beliefs and proposals, but it may never be the reason traffic moves, and its
weight is earned back from our own graded outcomes.**

Concretely:

- AA enters the explore posterior only as pseudo-counts, capped at one fifth of
  the surface's `MIN_GRADED_UNITS` (§5a).
- The pseudo-count cap is multiplied by a **trust factor** `τ ∈ [0, 1]`,
  measured from how often AA's ordering of our arms matched our own graded
  ordering (§7). If AA stops predicting, `τ → 0` and AA drops out of the prior,
  the veto and the suggestions without a deploy.
- The allocate step is recomputed with AA zeroed. If the result is the current
  allocation, nothing is written (§5c). This is the same rule popularity has.
- AA can **lower** automation: it can veto an auto-challenger and lower a
  suggested weight. It can **propose**: it writes `suggestion` rows. It never
  raises a share or a weight by itself.

If this is wrong, and AA were allowed to trigger moves or to override graded
outcomes, a public benchmark refresh would re-route a team's traffic overnight.
Benchmarks are tuned against, and vendors optimize for them. The pools design's
central promise, that traffic follows our own graded results, would stop being
true.

### 1. Access tier, limits and licence

#### 1a. Endpoints

| Endpoint | Tier | Use |
|---|---|---|
| `GET /api/v2/language/models/free` | any key (Free, Pro, Commercial); a Pro key still gets the Free shape here | the free path |
| `GET /api/v2/language/models` | **Pro+**; a Free key gets `403` "Language models list requires a Pro subscription" | the Pro path |
| `GET /api/v2/language/models/{slug}` | Pro+ (the `providers` array is Commercial-only) | **not used**. Detail-only fields (evaluation token counts, omniscience and openness breakdowns) do not feed any score. |
| `/language/models/{slug}/performance`, `/language/providers*`, measurements | Commercial only | not used |

Both list endpoints are paginated with `page` (1-indexed) and return
`pagination { page, page_size, total_pages, has_more }` (the documented page
size is 200). Auth is the `x-api-key` header. Every authenticated response
carries `X-AA-Tier` (`free` | `pro` | `commercial`), which mirrors the body's
`tier`, plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` (a unix time). A `429` also carries `Retry-After`.

Only the Pro list accepts `prompt_type`: `medium` (1k input), `long` (10k,
**the default**), `100k`, `vision_single_image`, `medium_coding`,
`medium_parallel`. The free endpoint takes only `page`, and its schema does not
state which preset its medians come from.

#### 1b. Fields by tier

Per model (`FreeModelData` on free, `ModelDataExternal` on Pro):

| Group | Free (`/free`) | Pro adds (`/language/models`) |
|---|---|---|
| Identity | `id` (stable, AA's recommended key), `name` (may change), `slug` (infrequently changed), `release_date`, `model_creator { id, name }` | `model_creator.country`, `reasoning_model`, **`openrouter_api_id`**, `huggingface_url` |
| Composite indexes | `artificial_analysis_intelligence_index`, `artificial_analysis_coding_index`, `artificial_analysis_agentic_index` | `artificial_analysis_openness_index`, `artificial_analysis_multilingual_index` |
| Benchmarks | none | `tau2_telecom` (τ²-Bench Telecom), `tau_banking` (τ³-Banking), `terminalbench_hard`, `terminalbench_v2_1`, `terminalbench_v4_0`, `terminalbench_science`, `ifbench`, `scicode`, `aa_lcr`, `hle`, `gpqa_diamond`, `critpt`, `gdpval_aa_elo`, `gdpval_aa_normalized`, `mmmu_pro`, `mlcr_overall`, `aa_omniscience_index`, `aa_omniscience_accuracy`, `aa_omniscience_non_hallucination_rate` |
| Pricing (USD/1M) | `price_1m_input_tokens`, `price_1m_output_tokens`, `price_1m_cache_hit_tokens`, `price_1m_cache_write_tokens` | `price_1m_blended_3_to_1`, `price_1m_blended_7_to_2_to_1` |
| Performance | `median_output_tokens_per_second`, `median_time_to_first_token_seconds`, `median_time_to_first_answer_token_seconds`, `median_end_to_end_response_time_seconds` | p05, q25, q75 and p95 of output tokens/s and of TTFT; the `prompt_type` selector |
| Eval cost | `artificial_analysis_intelligence_index_cost { total_cost, cost_per_task.total_cost }` | input/reasoning/answer cost split; `artificial_analysis_intelligence_index_token_counts` |
| Other | none | `context_window_tokens`, `parameters`, `modalities`, `licensing.is_open_weights` |
| Response | `tier`, `intelligence_index_version` (major.minor, as a number) | same |

**Not in the v2 schema at all**, despite older AA material: a math index, and
LiveCodeBench, AIME, MATH-500 and MMLU-Pro. The legacy
`/api/v2/data/llms/models` response carried some of them. This design uses
none of them, and it does not use the legacy endpoint.

**What the design loses on free, and what that costs:**

| Lost on free | Effect | Mitigation |
|---|---|---|
| Per-benchmark scores (Terminal-Bench, τ², IFBench) | The agent score is the two composites only; the chat score has no IFBench term (§4). | Both composites already fold in Terminal-Bench and the agentic evals, so the free score is coarser but not blind. |
| `openrouter_api_id` | There is no authoritative join to OpenRouter. More rows land in `pending` (§2). | A deterministic slug rule, plus one-click admin confirmation. |
| `reasoning_model` | Effort variants are parsed from `slug`/`name` only. | The parser cross-checks both. If they disagree, the mapping is `pending`. |
| Percentiles, `prompt_type` | The chat latency term uses the median, not the tail. The preset is unknown. | The snapshot records `tier` and the preset, and scores from different presets are never compared (§4c). |
| Blended prices | None. `(3·in + out)/4` is exactly `price_1m_blended_3_to_1`'s definition, and the 7:2:1 blend is computable from the free cache-hit price. | Blends are computed in code from the free fields on both tiers, so there is a single formula. |
| Context window | none | The catalog's `contextLength` stays the source (`MIN_CONTEXT_TOKENS`). |

The design **works on free and improves on Pro**: the Pro-only terms are
additive (§4), and the Pro join makes most mappings automatic (§2).

#### 1c. Rate limits

From the OpenAPI document: a **fixed 24-hour window**, not a rolling one, that
starts at the first request after the previous window ends. The quota is
scoped to the key's user-in-organization or to the whole organization, and
every key in that scope shares it.

| Tier | Requests per window |
|---|---|
| Free | 100 |
| Pro | 500 |
| Commercial | custom |

(The older free-API docs page still says 1,000 per day. The OpenAPI figure is
the contract, and the design budgets against 100.)

**Our budget:** one fetch per team per day, of `total_pages` requests (two or
three at today's model count), hard-capped at `AA_MAX_PAGES = 10`. Add one
verify request when a key is saved or replaced. A `429` is not retried that
day. A single team therefore uses under 5% of a free quota, which leaves room
for the owner's own use of the same AA organization.

#### 1d. Key and secrets

- New `secrets.purpose`: **`data_api_key`**, label **`artificial_analysis`**.
  It is team-scoped (`accountId` and `workspaceId` NULL). It is not a personal
  purpose (it is not added to `PERSONAL_SECRET_PURPOSES`). A data-source key
  is not an inference credential, so it does not reuse `inference_key`, and
  `resolveInferenceCredential` never returns it. The label leaves room for a
  second data source without another purpose.
- **Per team, never shared.** Each team fetches with its own key, and its
  snapshots feed only its own pools. This follows tier-weights open question 5:
  no tenant's credential serves another tenant. It also keeps AA's per-org
  quota and licence terms attached to the account that accepted them.
- **Storing the key is the opt-in.** Unlike the OpenRouter key, this key has
  no other use. Without it, nothing is fetched, every arm gets the neutral
  prior and no row is shown. **Defaults are no-ops.**
- **Verify on save.** `PUT` calls `/free?page=1` once, reads `X-AA-Tier`, and
  stores the tier in the secret's metadata. A `401` rejects the key inline, the
  same way `ProviderKeyCard` shows a provider refusal.
- **Tier drift.** If a Pro call returns `403`, the stored tier drops to `free`
  and that day's fetch continues on `/free`. A monthly re-verify picks up an
  upgrade.
- The owner creates the AA account and adds the key on Settings → Models, or
  with `manage_secrets action=set purpose=data_api_key label=artificial_analysis`.

#### 1e. Licence and attribution

- **Attribution is required on every tier** whenever AA data is displayed or
  shared: credit Artificial Analysis (`https://artificialanalysis.ai/`) as the
  source; "a visible byline or footer link is sufficient". Use is also subject
  to AA's Terms of Use and Data Platform Terms, and redistribution rights need
  a separate agreement.
- **Our policy: never re-served.** No API route, MCP action, export, webhook,
  digest or change-log response returns AA rows, scores or derived values to a
  client, apart from the one UI row in §8. That row is shown only to members of
  the team whose key fetched it, with the attribution link. Change-row evidence
  stores what is needed for replay (§5e), and the change-log API strips it, as
  it does popularity.
- **Stored, not published.** The raw rows are kept (§3) because
  reproducibility needs them. Storing data for internal decisions is the use
  the API exists for. Storage is per team, and no read path crosses teams.

### 2. ID mapping

#### 2a. Keys

- **AA side:** `id` (a stable UUID) is the mapping key. `slug` and `name` are
  stored for display and matching but never used as the key, because AA says
  both may change.
- **Our side:** a catalog entry (`CatalogEntry.id`, the native id) plus an
  **effort**. From the catalog entry we reach `openRouterId` (OpenRouter's
  `id`, which is what AA's `openrouter_api_id` holds) and W6's `permaslug`
  (OpenRouter's `canonical_slug`, which is what the rankings `model_permaslug`
  holds). So one confirmed mapping links all four identifiers:

```
AA id ──(mapping row)──▶ catalog id + effort ──▶ openRouterId  (= AA openrouter_api_id)
                                              └─▶ permaslug     (= rankings model_permaslug)
```

  The OpenRouter ids are never stored on the mapping. They are read from the
  catalog at use time and written into evidence, so a catalog re-slug cannot
  leave a stale copy.

#### 2b. Effort variants

AA lists one row per reasoning configuration: for example `GPT-5 (high)` and
`GPT-5 (low)`, or a Claude model's `(Reasoning)` and `(Non-reasoning)` rows,
each with its own `id`. `parseAaEffort(slug, name)`, which is pure, returns
one of:

```
minimal | low | medium | high | xhigh | max       ladder efforts
reasoning | non_reasoning | adaptive              binary / adaptive modes
none                                              no effort marker
```

It reads a trailing slug token (`-high`, `-xhigh`, `-thinking`, `-reasoning`,
`-non-reasoning`, `-adaptive`, …) and a parenthetical in `name`. If both
carry a marker and they disagree, the result is `conflict`. On Pro,
`reasoning_model = false` forces `non_reasoning` and conflicts with any ladder
marker.

**Our effort for an arm.** Arms have no effort column. The effort is
`modelTierRegistry.defaultEffort` for the pool's `(team, workspace, tier,
surface)` row, else `unset`. `EFFORT_EQUIVALENCE` is a fixed table in code
that says which AA efforts match an arm's effort:

| Our effort | Matches (first present wins) |
|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` | the same ladder value → `reasoning` → `adaptive` → `none` |
| `unset`, agent surface | `high` → `adaptive` → `reasoning` → `none` (agent runs think by default) |
| `unset`, chat surface | `non_reasoning` → `none` → `medium` |

This is a stated rule, not a guess. If the table finds no variant for the arm,
or finds two AA ids at the same rank, the arm has **no AA score** and a
`pending` row is raised (§2d).

#### 2c. Matching an AA row to the catalog

`matchAaRow(row, catalog)` is pure and deterministic, and returns
`{ status, candidates[], method }`:

1. **Pro join.** If `openrouter_api_id` is non-null and exactly one catalog
   entry has `openRouterId === openrouter_api_id` (else `permaslug ===` it),
   the status is `mapped` and the method is `openrouter_api_id`.
2. **Exact slug.** Strip the effort token and normalize (lowercase, `.` → `-`).
   Resolve the vendor from `model_creator.name` through a fixed table
   (`OpenAI → openai`, `Anthropic → anthropic`, `Google → google`, …); an
   unknown creator means no match. If the normalized slug equals exactly one
   same-vendor catalog entry's `id`, `canonicalId` or `snapshotBase(id)`, the
   status is `mapped` and the method is `slug_exact`.
3. **Token multiset.** If the slug's tokens equal a same-vendor catalog id's
   tokens up to order (AA's older `claude-4-5-sonnet` against our
   `claude-sonnet-4-5`), the status is `pending` with that candidate. A
   reordering is plausible but not certain, so it waits for a person.
4. **Several hits** at any step: `pending` with all candidates (ambiguous).
5. **Nothing:** `unmatched`.

The effort (§2b) is then attached. A row whose effort parse is `conflict` is
`pending` even when steps 1–2 matched.

#### 2d. How unmatched and ambiguous cases surface

Mappings live in `model_signal_mappings` (§3a), one row per `(team, AA id)`,
with statuses:

| Status | Meaning | Used in scoring? |
|---|---|---|
| `mapped` | written by a step-1/2 rule | yes |
| `confirmed` | an admin chose the target | yes |
| `pending` | candidates exist, but no rule is certain | **no** |
| `unmatched` | no candidate | no |
| `ignored` | an admin said "no AA equivalent" | no |
| `stale` | the AA id was missing from the last 3 snapshots, or a Pro `openrouter_api_id` now points somewhere other than a `confirmed` target | no |

- **Nothing is guessed silently.** An arm whose model has no `mapped` or
  `confirmed` row gets the neutral prior (no AA term), and its UI row shows
  `aa ?` with a `[map]` control (§8).
- **Only relevant rows surface.** An AA catalog holds hundreds of models, and
  most are irrelevant. The UI lists a pending item only when an **arm or
  incumbent in the team's pools**, or a candidate being added in the add
  sheet, has no usable mapping. Other `unmatched` rows are stored and counted
  in the cron's `changed` metric, and nothing else happens with them.
- **An admin choice is never overwritten.** Rules re-run on every snapshot but
  write only `mapped` and `unmatched` rows, and only over non-admin rows. A
  conflict with a `confirmed` row sets it to `stale` and surfaces it again. It
  never moves it.
- Mappings are **per team**. They are written by that team's admins and read
  only by that team's pools, so one tenant's click cannot change another
  tenant's routing. The rules are code, so every team gets the same automatic
  rows.

### 3. Storage and cadence

#### 3a. Tables

```
model_signal_snapshots
  id uuid pk
  team_id uuid not null → teams
  source text not null                 -- 'artificial_analysis'
  as_of date not null                  -- UTC day the fetch ran for
  fetched_at timestamptz not null
  tier text not null                   -- 'free' | 'pro' | 'commercial' (X-AA-Tier)
  prompt_type text not null            -- 'long' on Pro; 'free-default' on free
  index_version numeric not null       -- intelligence_index_version
  status text not null                 -- 'ok' | 'partial' | 'failed'
  page_count int, row_count int, error text
  unique (team_id, source, as_of)

model_signal_rows                      -- one per AA model per snapshot
  snapshot_id uuid → model_signal_snapshots (cascade)
  aa_id text, slug text, name text, creator text, release_date date
  effort text                          -- parseAaEffort result
  openrouter_api_id text null          -- Pro only
  intelligence, coding, agentic numeric null
  price_in, price_out, price_cache_hit, price_cache_write numeric null
  tps_median, ttft_median, ttfa_median, e2e_median numeric null
  ttft_q75 numeric null                -- Pro only
  extra jsonb not null default '{}'    -- remaining Pro evaluations/percentiles, verbatim
  pk (snapshot_id, aa_id)

model_signal_mappings
  team_id uuid, source text, aa_id text           -- pk
  catalog_id text null, effort text null
  status text not null                  -- §2d
  method text not null                  -- 'openrouter_api_id' | 'slug_exact' | 'admin' | 'rule_none'
  candidates jsonb not null default '[]'
  decided_by uuid null → users, decided_at timestamptz null
  updated_at timestamptz not null

model_signal_validations                -- §7, append-only
  id uuid pk, team_id, surface, pool_id, arm_id, incumbent_arm_id
  stage int, snapshot_id uuid           -- the snapshot the prediction came from
  aa_gap numeric, outcome_gap numeric, concordance numeric   -- 1 | 0.5 | 0
  created_at timestamptz
```

All tables are additive, and nothing reads them until a key exists. Numbers
are typed columns so scoring never parses jsonb, and `extra` keeps the Pro
fields we do not score yet, so a later scoring version can be replayed against
old snapshots.

#### 3b. Cadence

- One step in `/api/cron/tier-pools` (W7): the **first run after 04:00 UTC**
  for each team with a `data_api_key` and no snapshot for today's `as_of`. The
  rankings step (W8) runs after 03:00 UTC, so the two do not contend.
- Fetch every page up to `AA_MAX_PAGES` (Pro path or `/free` by stored tier),
  parse with `normalizeAaResponse`, run `matchAaRow` for each row, and write
  the snapshot, rows and mapping updates. A snapshot is written only when
  every page parses. A mid-run failure writes a `failed` snapshot with no rows
  and no mapping changes, so a half-page never becomes history.
- `401`, `403` (after the free fallback), `429` or `5xx`: no retry that day.
  The failure is recorded on the snapshot row.

#### 3c. Staleness

`age = today − as_of` of the team's newest `ok` snapshot.

| Age | Prior, veto, suggestions | UI row |
|---|---|---|
| ≤ 7 days | used | shown |
| 8–14 days | **not used**: neutral prior, no veto, no AA suggestions | shown, with the `as_of` date appended as a value (`· 09-14`) |
| > 14 days | not used | hidden |

The 7-day cut matches the rankings rule (tier-weights §4a), so the two priors
go neutral together.

#### 3d. History and reproducibility

- Snapshots are **immutable**. A decision's evidence names the `snapshot_id`
  it used (§5e), and replaying a step reads that snapshot, not the latest one.
- **Retention:** a snapshot referenced by any `tier_pool_changes.evidence` or
  `model_signal_validations` row is kept for as long as the referencing row
  exists. Unreferenced snapshots are pruned after 180 days by the same cron,
  up to 50 per run. `model_signal_mappings` keeps only current state, and the
  mapping used is copied into evidence at decision time.

### 4. Per-surface score

A score is computed per `(AA row, surface)` by `surfaceScore`, which is pure
and lives in `packages/core/model-quality.ts`. It is on a 0–100 scale (the
indexes' scale), or `null` when the inputs are missing. No model call is
involved.

#### 4a. Agent surface

```
free:  S_agent = 0.5·coding + 0.5·agentic
Pro:   S_agent = 0.35·coding + 0.35·agentic + 0.15·TB + 0.15·TAU
         TB  = 100 · terminal-bench field (see below)
         TAU = 100 · mean of the non-null of { tau2_telecom, tau_banking }
```

- **Terminal-Bench field.** Use the first of `terminalbench_v4_0`,
  `terminalbench_v2_1` and `terminalbench_hard` that is non-null **for every
  model in the comparison set** (the pool's live arms plus the candidate). If
  none qualifies, the TB term is dropped. The same rule applies to TAU. A
  dropped term's weight is spread over the rest in proportion. The chosen
  fields go into evidence, so the score is deterministic given the set.
- If `coding` or `agentic` is null, the other one carries its weight. If both
  are null, `S_agent = null`.
- The composites already include Terminal-Bench. On Pro, the explicit TB and
  TAU terms add the agentic, tool-driven share on purpose, because that is
  what agent runs are.

#### 4b. Chat surface

```
T     = median_time_to_first_answer_token_seconds   (Pro: quartile_75 TTFT when present)
R     = median_output_tokens_per_second
lat   = 100 · clamp( ln(10 / T) / ln(10 / 0.3), 0, 1 )     0.3 s → 100, 10 s → 0
speed = 100 · clamp( ln(R / 20) / ln(300 / 20), 0, 1 )     20 t/s → 0, 300 t/s → 100

free:  S_chat = 0.60·intelligence + 0.25·lat + 0.15·speed
Pro:   S_chat = 0.45·intelligence + 0.15·(100·ifbench) + 0.25·lat + 0.15·speed
```

- **Time to first answer token, not first token.** For a reasoning model the
  first token is often a thinking token that the chat canvas does not render.
  What the user waits for is the answer. For non-reasoning models the two are
  equal. If the answer-token time is null, TTFT is used.
- **Log scales** because a drop from 4 s to 2 s matters as much to a reader as
  one from 1 s to 0.5 s. The anchors are constants in `QUALITY_POLICY`.
- **On Pro, the tail replaces the median** for latency: the chat reason code
  `too_slow` (`CHAT_FEEDBACK_REASONS`) is a tail complaint, and Pro exposes
  q75.
- A null term drops out and its weight is redistributed. If `intelligence` is
  null, `S_chat = null`: speed alone is not a quality signal.

#### 4c. Comparability

Two scores are compared only when they come from the **same snapshot**, which
means the same tier, the same `prompt_type` and the same
`intelligence_index_version`. Every consumer (§5, §6, §7) compares an arm with
the incumbent or with a candidate inside one snapshot. Scores are never
compared across snapshots.

`QUALITY_POLICY` (the weights, anchors and constants in §5–§7) is one
versioned object, `version: 1`, recorded in every evidence row, in the same
way as `EXPLORE_POLICY`.

### 5. Weight in the prior

#### 5a. Pseudo-units

For a challenger arm `a` and the pool's incumbent `i`, with both mapped and
both scored in the same fresh snapshot:

```
gap    = S(a) − S(i)                                    index points
s      = clamp(0.5 + gap / (2 · SPAN), 0, 1)             SPAN = 10 points
m      = 0.5 + 0.3 · (s − 0.5)                           ∈ [0.35, 0.65]
n      = τ_surface · AA_UNITS[surface]                   AA_UNITS = { agent: 6, chat: 10 }
α₀ += n · m        β₀ += n · (1 − m)
```

- **The size is `MIN_GRADED_UNITS / 5`**: 6 units for agent (M = 30) and 10 for
  chat (M = 50). When an arm leaves learning, AA is at most `n / (n + M)` =
  **one sixth** of its posterior weight, at stage 2 at most one eleventh, and
  at stage 3 under 5%. **Graded outcomes dominate once `MIN_GRADED_UNITS` is
  met**, and more so at every later stage.
- **Against popularity:** 4 units at `m ∈ [0.45, 0.55]` gives a spread of 0.4
  pseudo-successes between the best and worst arm. AA at full trust gives 1.8
  (agent) and 3.0 (chat): about 4.5× and 7.5× popularity's pull. That fits
  what each signal measures. AA measures task quality on public work, and
  popularity measures adoption. In pseudo-units, AA at full trust is 1.5×
  (agent) and 2.5× (chat) popularity's 4. At the default trust of 0.5 (§7b)
  it is 3 and 5 units, under 10% of a learning-exit posterior.
- **Relative to the incumbent**, because the pool question is always "better
  or worse than what we run now". A gap of 10 index points or more saturates.
  AA's composites move a few points between adjacent releases, and a
  ten-point gap is a different class of model.
- **The incumbent gets no AA term.** Its prior is its own last 30 days on the
  pool (tier-weights §3c). The AA term goes where popularity's pseudo-counts
  go: the challenger's `α₀, β₀`.
- **No term** (neutral) when either arm is unmapped, either score is null, the
  snapshot is stale (§3c), or `τ = 0`.

#### 5b. Where it sits in the combination order

tier-weights §4c, with one step inserted:

1. Evidence: the arm's own posterior.
2. Popularity: at most 4 units.
3. **Quality (AA): at most `AA_UNITS[surface] · τ` units.** *(new)*
4. Stage caps.
5. Succession and expiry caps. Only lowers.
6. Harm cut.

#### 5c. Can AA trigger a change?

| Action | Popularity | AA | Why |
|---|---|---|---|
| Move an existing arm's share (explore step) | never | **never** | Traffic follows our graded results. |
| Add an auto-challenger | never | **never alone.** Succession still triggers it (§5d). | Adding at `LEARN_SHARE` takes 0.10 from the incumbent. That is a traffic move. |
| Block an auto-challenger (veto) | n/a | **yes** (§5d) | It only lowers automation. |
| Write a `suggestion` row | no | **yes** (§5d) | A suggestion moves nothing until an admin applies it. |
| Change a weight in split | never | **never** | The admin's weights are final (tier-weights §1). |
| Lower a suggested weight in the add sheet | no | **yes, `med` → `low` only** (§6) | Preset, not a write. The admin can change it. |

**The "never triggers" check is extended.** After tier-weights §3c step 7, the
step is recomputed with popularity **and** quality pseudo-counts zeroed. If the
result equals the current allocation, nothing is written. AA can change *how
far* a move goes that evidence already justifies. It cannot be the reason for
a move.

**Attribution** stays counterfactual: `quality` is one more signal that the
step removes and recomputes. If it changes the quantized result, it is listed
in `causes`. It never becomes `actor_system`, because it can never be the
highest-precedence cause alone. The actor stays `system:explore`,
`system:succession` and so on, and `causes` shows that AA contributed.

#### 5d. Succession and challenger proposals

tier-weights §4b is unchanged in which models qualify. AA adds two things.

**Quality veto on the automatic path.** In an explore pool with
`auto_challenger` on, before `findSuccessor`'s pick is added at
`LEARN_SHARE`:

```
veto if  τ_surface ≥ 0.25
     and both scored in one fresh snapshot
     and S(successor) < S(old arm) − VETO_MARGIN     VETO_MARGIN = 3 points
```

A vetoed successor gets a `suggestion` row instead (`signal: 'succession'`,
`qualityVeto: { gap, snapshotId, asOf }`). No arm is added, and the old arm's
decay does not start, because decay starts when the successor joins. An admin
can still add it by hand. A successor that AA does **not** score is not
vetoed: missing data never blocks the catalog rule. This is the one place AA
changes an automatic outcome, and it can only prevent traffic moving.

**Quality suggestions (`signal: 'quality'`).** On each daily step, for each
pool, and at most one per pool per 14 days:

- **Same-family, undecidable version.** tier-weights §4b says: "If either id
  has no numeric token, there is no succession." AA fills that gap for the
  suggestion path only. A same-vendor, same-`modelFamily` catalog entry that
  passes §4b rules 4–6 (not a preview or snapshot, servable, in band) with a
  newer AA `release_date` and `S ≥ S(arm) + VETO_MARGIN` gets a suggestion row.
- **Same-family successor that scores higher.** When `findSuccessor` finds a
  successor and AA scores it higher, nothing new happens in explore, because
  succession already acts. In **split**, the tier-weights `suggestion` row
  carries `quality: { gap, asOf }` so the admin sees why it matters.
- **Cross-family candidates are not proposed.** Proposing any in-band model
  that scores higher would turn buildd into a leaderboard feed. The add sheet
  shows the scores (§8), and the choice stays with the admin.

All AA-driven rows need `τ_surface ≥ 0.25` and a fresh snapshot.

#### 5e. Evidence

Every change row (and suggestion row) whose step had AA data present gains:

```
signals: [ ...,
  { kind: 'quality', source: 'artificial_analysis', snapshotId, asOf, tier,
    indexVersion, policy: 'quality-v1', trust: τ,
    arms: { [armId]: { aaId, catalogId, effort, score, gap, m, n } },
    fields: { tb: 'terminalbench_v4_0' | null, tau: [...] } } ]
causes: [ ..., 'quality' ]          -- only if counterfactually load-bearing
```

**Every automatic change cites its signal and `as_of`.** The change-log API
strips `signals[kind='quality'].arms` and `trust` (licence, §1e), in the same
way it strips popularity. Replay reads `snapshotId`.

### 6. Price source

**The catalog stays the price source. AA is the fallback, and it never
replaces the catalog.**

- The OpenRouter catalog price is what the `openrouter` route actually bills,
  and it is what `model-prices.ts` already charges cost attribution against.
  AA's price is AA's own representative price across providers, and for an
  open-weights model it can differ from what we pay. Using one source keeps
  the add sheet, the suggestion and the cost report in agreement.
- AA's blended field adds nothing on Pro. `price_1m_blended_3_to_1` is by
  definition tier-weights' `(3·input + output)/4`, which is computable from the
  free fields.

**Fallback rule** (`suggestionPrice`, pure):

1. If both the challenger and the incumbent have catalog prices → catalog
   (`priceSource: 'openrouter-catalog'`).
2. Else, if both have **mapped** AA prices in one fresh snapshot → AA for
   both (`priceSource: 'artificial-analysis'`, with `snapshotId`, `asOf`). A
   typical case is a model AA has benchmarked before OpenRouter lists it.
3. Else, unknown → `low`, as today.

The two sources are never mixed inside one ratio.

**Quality in the suggestion (amends tier-weights §2 non-goal "the suggestion
is price only").** AA can only lower the preset:

```
ratio > 1.25                                      → low      (unchanged)
ratio ≤ 1.25 and gap ≤ −LOWER_MARGIN              → low      cheaper, clearly worse
ratio ≤ 1.25 otherwise (incl. no AA data)         → med      (unchanged)
LOWER_MARGIN = 5 points; requires τ_surface ≥ 0.25
```

A pricier model that scores higher still starts `low`: spending more is an
admin choice, and the admin can click `med` or `high`. The evidence gains
`{ qualityGap, qualitySnapshotId, qualityAsOf }` next to tier-weights'
`{ suggestedWeight, chosenWeight, ratio, priceSource, catalogAsOf }`.

### 7. Validation: does AA predict our outcomes?

#### 7a. Observations

An observation is recorded when a challenger crosses a **stage boundary**
(`g` reaches M, 2M or 4M, tier-weights §3b) in an explore pool, and when a
split-pool arm reaches M graded units:

```
aa_gap      = S(arm) − S(incumbent)   from the snapshot in force when the arm JOINED
outcome_gap = mean_q(arm) − mean_q(incumbent)   over the same window, from summarizeArm
concordance = 1    if sign(aa_gap) = sign(outcome_gap)
              0    if they disagree
              0.5  if |outcome_gap| < 0.02
excluded        if |aa_gap| < 1 point, or either arm lacked a mapped score at join
```

- It uses **the join-time snapshot**, so the question is what AA predicted
  before we had data. That is the only prediction a prior makes.
- Stage boundaries give at most three observations per arm, which avoids
  counting daily steps that are correlated with each other.
- Rows go to `model_signal_validations` and are append-only.

#### 7b. Trust

Per team and surface, daily, over the latest 40 observations within 365 days:

```
n < 8               τ = 0.5                        (TRUST_START; unproven)
n ≥ 8               C = mean(concordance)
                    τ = clamp((C − 0.5) / 0.25, 0, 1)
```

- `C ≥ 0.75` (AA ordered our arms correctly three times in four) gives full
  trust. `C ≤ 0.5` (no better than a coin) gives `τ = 0`, and AA drops out of
  the prior (§5a), the veto (§5d), suggestions (§5d) and the suggestion
  lowering (§6).
- **Trust less, automatically, and recover automatically.** When `C` recovers,
  `τ` recovers. No admin action is needed in either direction. `τ` and `n` are
  recorded in every evidence row, so a reader can see what weight AA carried
  that day.
- **Unproven means half weight**: `τ = 0.5` gives 3 agent units and 5 chat
  units. At that level the veto and suggestions are live (`τ ≥ 0.25`), and
  the prior is under 10% of a learning-exit posterior.
- Per team, because each team's workload is what is being predicted.
  Cross-team pooling would need a platform read across tenants' outcomes, and
  that is a non-goal.

### 8. UI

At most **one compact row per model**, values only. The row appears under the
model id on pool arm rows and on add-sheet rows. It never appears in a
separate panel.

```
agent pool arm      coding 58.5 · agentic 61.2 · $5/$30
chat pool arm       intel 62.1 · ttft 1.2s · 180 t/s · $5/$30
unmapped            aa ? [map]
stale (8–14 d)      coding 58.5 · agentic 61.2 · $5/$30 · 09-14
```

- On Pro, the agent row gains `tb 44.0`. The chat row shows the median TTFT
  even though scoring uses q75, because the median is the number people know.
- The `$in/$out` is the **same price the suggestion used** (§6). It is not a
  second AA price.
- `[map]` opens an inline list of the pending candidates plus `none`. Choosing
  one writes `confirmed` or `ignored`. It is owner/admin only, and members see
  `aa ?` read-only.
- One footer link per section, `Artificial Analysis`, pointing to
  `https://artificialanalysis.ai/`. This is the attribution AA requires (§1e):
  a source label, not explainer copy.
- There is no score explanation, tooltip, trust value, prior or rationale text
  anywhere. The key card is `ProviderKeyCard` with the label `Artificial
  Analysis` and the stored tier as a value (`free` / `pro`).

### Safety property

- **Defaults are no-ops.** With no `data_api_key` there is no fetch, no row,
  no AA term, no veto and no suggestion. Every pool behaves exactly as
  tier-weights specifies.
- **AA never moves traffic.** It is excluded by the counterfactual check
  (§5c). It never changes a split weight. It is at most `M/5` pseudo-units,
  scaled by `τ`.
- **The only automatic effect is subtractive**: the succession veto, which
  prevents an arm being added.
- **Self-limiting.** A trust factor below 0.25 disables every AA effect, and
  it is recomputed daily from our own outcomes.
- **External calls are bounded**: at most `AA_MAX_PAGES` (10) requests per
  team per day plus one per key save, no retry loop, on the team's own key.
- **Nothing is guessed.** An unmapped, ambiguous or effort-conflicted model
  gets no score and surfaces as `aa ?`.

## Open questions

1. **`AA_UNITS = M/5` and `SPAN = 10`.** I lean to these: they keep AA under
   one sixth of a learning-exit posterior and make a ten-point gap the
   saturation point. The first real validation window (§7) should inform a
   `QUALITY_POLICY` v2. The alternative of equal weight with popularity
   (4 units) undersells a quality signal against an adoption signal.
2. **Trust starts at 0.5, not 1.** Starting at 1 gives AA full weight before
   it has predicted anything for us. Starting at 0 means it never acts until
   eight observations exist, which at fleet volume is months. I lean to 0.5.
3. **Chat latency on the answer token.** If the chat canvas starts streaming
   thinking tokens to the user, first-token time becomes the right measure.
   This is a one-line change in `QUALITY_POLICY` and a version bump.
4. **Pro `prompt_type`.** I use `long` (the default, 10k input) for both
   surfaces, since agent and chat prompts with tools and system context are
   nearer 10k than 1k. `medium_coding` exists but has a 1k input. I lean
   against a per-surface preset, which would double the Pro fetch.
5. **Per-team keys versus one platform key.** The same trade-off as
   tier-weights open question 5, and the same lean: per team. One platform
   fetch would be 3 requests a day in total, but it would need a
   platform-owned credential purpose and would share one licensee's data
   across tenants, which AA's terms reserve for a separate redistribution
   agreement.
6. **AA's Data Platform Terms** are published as a PDF that could not be
   machine-read while writing this. The design's "never re-served" policy is
   stricter than the OpenAPI licence text either way. The owner should read
   the PDF when creating the account and confirm that storing snapshots for
   internal replay is covered. If it is not, §3d retention drops to "only
   snapshots referenced by a change row".

## Non-goals

- **Leaderboards or model recommendations.** AA does not propose
  cross-family challengers (§5d), and no page ranks models by AA score.
- **Re-serving AA data** through any API, MCP action, export or digest (§1e).
- **Detail, provider and performance-over-time endpoints.** They are
  Pro-detail or Commercial, and nothing here needs them.
- **A second price source for cost attribution.** `model-prices.ts` is
  unchanged. AA prices only back up the suggestion (§6).
- **Cross-team validation or pooled trust.** Trust is per team (§7b).
- **A model call anywhere.** Parsing, mapping, scoring, trust and attribution
  are deterministic code.
- **Media, speech and music endpoints.**

## Implementation breakdown

Ordered, with the load-bearing piece first. Each unit is one task and one PR.
`dependsOn` refers to the unit ids below (`Q*`) and to the tier-weights units
(`W*`, see that doc's breakdown). W1–W4 are in flight as one PR at the time of
writing. Q units that depend on W7–W9 wait for them. Q1 and Q2 can start now,
and Q5 can start as soon as Q2 lands.

| # | Unit | Paths (manifest) | dependsOn |
|---|---|---|---|
| Q1 | **Done.** **Quality core (pure).** `QUALITY_POLICY` v1; `normalizeAaResponse` (free and Pro shapes, pagination, `tier`, `intelligence_index_version`); `parseAaEffort`; `surfaceScore` for agent and chat with field-set selection and weight redistribution (§4); `qualityPrior` (§5a); `trustFromObservations` (§7b); `suggestionPrice` (§6). Tests: parsing both tiers' shapes inline (no fixture files — the OpenAPI examples were not fetched), null handling, the TB field fallback, log anchors, the 10-point saturation, `τ` at n < 8, C = 0.5 and C = 0.75. **Open for Q4:** the OpenAPI document's §1b bucket for Pro's TTFT percentiles (p05/q25/q75/p95) has no field name confirmed against a live response, so `AaModelRow.ttftP75Seconds` is always null for now and `chatRowScore` uses the median on every tier; confirm the real key when Q4 does a live fetch. | `packages/core/model-quality.ts`, `packages/core/__tests__/model-quality.test.ts`, `packages/core/package.json` | — |
| Q2 | **Schema.** The four tables in §3a and the `data_api_key` purpose added to `SecretPurpose` and the schema's purpose union. Follow the schema-change skill (migration index collisions with W2/W11). | `packages/core/db/schema.ts`, `packages/core/drizzle/**`, `packages/core/secrets/types.ts` | — |
| Q3 | **Mapping (pure).** `EFFORT_EQUIVALENCE`, the creator → vendor table, `matchAaRow` (§2c steps 1–5), `resolveArmAa(arm, effort, mappings, snapshot)` → `{aaId} \| {pending}`, the status transition rules (never overwrite `confirmed`; `stale`). Tests: Pro join, slug exact, token multiset → pending, two variants at the same effort → pending, name/slug effort conflict, re-slug with the same id keeps the mapping. | `packages/core/model-quality-mapping.ts`, `packages/core/__tests__/model-quality-mapping.test.ts` | Q1, W6 |
| Q4 | **Fetch source and cron step.** A source that loads the team key, fetches pages (tier from secret metadata, `403` → free fallback), and writes snapshot, rows and mappings only after every page parses; the pruning pass (§3d); the cron step after 04:00 UTC. Tests: `401`/`403`/`429`/`5xx` → no rows, partial page → `failed` snapshot, `AA_MAX_PAGES` cap, a referenced snapshot is not pruned. | `packages/core/model-quality-source.ts`, `packages/core/__tests__/model-quality-source.test.ts`, `apps/web/src/app/api/cron/tier-pools/route.ts`, `apps/web/src/app/api/cron/tier-pools/route.test.ts` | Q1, Q2, Q3, W7 |
| Q5 | **Key management.** `data_api_key` accepted by the inference-keys `PUT`/`DELETE`/verify (verify = one `/free` call reading `X-AA-Tier`, tier stored in metadata), by `manage_secrets`, and as a key card on Settings → Models. Tests: verify stores the tier, `401` rejected inline, a personal-scope write is refused. | `apps/web/src/app/api/inference-keys/route.ts`, `apps/web/src/app/api/inference-keys/route.test.ts`, `apps/web/src/app/api/inference-keys/verify/**`, `packages/core/mcp-tools.ts`, `apps/web/src/app/app/(protected)/settings/models/ModelTiersClient.tsx`, `apps/web/src/components/settings/ProviderKeyCard.tsx` | Q2 |
| Q6 | **UI row and mapping control.** The compact row on pool arm rows and add-sheet rows (§8), `aa ?` with `[map]` (owner/admin), the staleness date, the footer attribution link, and a `PATCH` for mapping decisions. A view helper builds the row string, so the component holds no logic. | `apps/web/src/lib/tier-pools-view.ts`, `apps/web/src/lib/tier-pools-view.test.ts`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.tsx`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.dom.test.tsx`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts`, `apps/web/src/app/api/model-tiers/pools/route.test.ts` | Q4, W4 |
| Q7 | **Prior in allocate.** The quality pseudo-counts on the challenger prior, the extended never-triggers check (popularity and quality zeroed), `quality` as a counterfactual signal, the §5e evidence block, and stripping it from the change-log API. Tests: AA-only difference → no write; AA changes the size of an evidence-driven move → `causes` includes `quality`; stale snapshot → neutral; `τ = 0` → neutral. | `packages/core/tier-explore.ts`, `packages/core/__tests__/tier-explore.test.ts`, `packages/core/tier-pool-admin.ts`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts` | Q3, Q4, W9 |
| Q8 | **Suggested weight: price fallback and quality lowering (§6).** Extends `suggestWeight`'s caller in the pools `POST` to pass AA price and gap, adds the `med → low` rule and the evidence fields. Tests: catalog present → catalog; both missing from catalog but in AA → AA; mixed → unknown → `low`; cheaper and 5 points worse → `low`; pricier and better → still `low`. | `packages/core/tier-weights.ts`, `packages/core/__tests__/tier-weights.test.ts`, `apps/web/src/app/api/model-tiers/pools/route.ts`, `apps/web/src/app/api/model-tiers/pools/route.test.ts` | Q1, Q3, Q4, W3 |
| Q9 | **Succession veto and quality suggestions (§5d).** The veto before the auto-challenger add, the same-family undecidable-version suggestion, the quality annotation on split succession suggestions, and the one-per-14-days limit. Tests: a successor worse by more than 3 points → suggestion, no arm added, no decay; unscored successor → added as before; `τ < 0.25` → no veto. | `packages/core/model-succession.ts`, `packages/core/__tests__/model-succession.test.ts`, `packages/core/tier-explore.ts`, `apps/web/src/app/api/cron/tier-pools/route.ts` | Q7, W9 |
| Q10 | **Validation and trust (§7).** Record observations at stage crossings and at split-arm M; compute daily `τ` per team and surface; feed `τ` to Q7, Q8 and Q9. Tests: join-time snapshot used (not the latest), exclusions, the 40-observation window, recovery. | `packages/core/model-quality-validation.ts`, `packages/core/__tests__/model-quality-validation.test.ts`, `apps/web/src/app/api/cron/tier-pools/route.ts` | Q7 |
| Q11 | **Close the loop in docs.** A "Model quality signals" line in `docs/SPEC.md` under model tiers when Q6 ships. Set this doc to Implemented when Q10 lands, and add a cross-reference in tier-weights §4. | `docs/SPEC.md`, `docs/design/model-quality-signals.md`, `docs/design/tier-weights.md` | Q6, Q10 |

Sequencing against tier-weights: Q1, Q2 and then Q5 run in parallel with W1–W6.
Q3 needs W6's `permaslug`. Q4 needs W7's cron. Q7 and Q9 need W9's signal
wiring. Q8 needs W3's `POST` suggestion. Q6 → Q4 delivers visible value (the
compact row, key and mapping) before any prior is wired, and on its own
changes no routing.
