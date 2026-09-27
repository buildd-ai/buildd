# Tier weights: weight-based splits, buildd-controlled explore, external priors

**Status:** Proposed
**Amends:** `docs/design/tier-model-pools.md` (§3 traffic modes and bounds, §3 auto-challenger, §6 auto-shift bounds, §8 data model, §9 admin screen). Where the two disagree, this doc wins.
**Related:** `packages/core/tier-pool.ts`, `packages/core/tier-pool-admin.ts`, `packages/core/tier-pool-source.ts`, `packages/core/model-catalog.ts`, `packages/core/model-catalog-cache.ts`, `packages/core/model-prices.ts`, `packages/core/model-capability-requirements.ts`, `packages/core/experiment-randomizer.ts`, `packages/core/db/schema.ts` (`tierPools`, `tierPoolArms`, `tierPoolChanges`, `systemCache`), `apps/web/src/app/api/model-tiers/pools/route.ts`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts`, `apps/web/src/lib/tier-pools-view.ts`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.tsx`, `cron-manifest.json`, `docs/design/model-tiers.md`, `docs/design/decision-calls.md`

---

## Problem

The P1 pool screen (`TierPoolsSection.tsx`) asks an admin to type a
percentage per arm, and the server (`validateAllocation` in `tier-pool.ts`)
rejects the split unless it sums to 100%, the incumbent keeps at least
`incumbentFloor` (0.6), and challengers together stay under `explorationCap`
(0.3). An admin who wants to try a second model half the time gets:

```
the base model keeps at least 60%
```

and has to do the arithmetic again. The footer under the inputs
(`Total 100% · base keeps at least 60% · others at most 30%`) is there to
explain rules the admin never asked for. Three concrete failures:

1. **Arithmetic is the admin's job.** Adding a third model means retyping every
   share so the total lands on 100.
2. **Split mode second-guesses the admin.** `split` means the admin sets the
   shares. The floor and cap are exploration-safety rules that belong to a mode
   where buildd moves traffic, not to one where a person already chose.
3. **Nothing moves on its own when the world changes.** When a newer release of
   an arm's family ships, or an arm's model is scheduled to expire, the pool
   keeps sending it the same share until someone notices. The pools design
   left `explore` and the auto-challenger for P2/P3 without saying which outside
   facts may move traffic, or how much.

## Current state

| Piece | Where | What this doc does with it |
|---|---|---|
| Allocation validation | `validateAllocation(input, arms, bounds)`, `DEFAULT_POOL_BOUNDS = { incumbentFloor: 0.6, explorationCap: 0.3 }` | Split stops calling it with bounds. Replaced by `sharesFromWeights`. |
| Draw | `pickArm` / `drawPoolArm` over `tier_pools.allocation`, cumulative intervals in `armOrder` | Unchanged. The draw still reads only the allocation. |
| Allocation writes | `writeAllocation` (compare-and-set on `allocation_version`, one `tier_pool_changes` row in the same statement) | Gains `weights` and `actorSystem`. |
| Add arm | `addChallenger` inserts at 0% (conditional insert, four-arm cap) | Inserts with a weight and writes the new allocation in the same statement. |
| Pool creation | `ensurePool` creates mode `split`, allocation `{incumbent: 1}` | Also writes `weights {incumbent: 'high'}`. |
| Eligibility | `poolEligibility` returns `pool_not_split` for anything but an unfrozen `split` pool | Admits `explore`. |
| Stats | `loadArmStats` / `summarizeArm`: severity counts, `meanQuality`, cost, p50 latency; `MIN_GRADED_UNITS = { agent: 30, chat: 50 }` | Feeds explore posteriors and learning stages. |
| Catalog | `normalizeCatalog` (OpenRouter `/api/v1/models`, keyless), `priceFromCatalog`, `modelFamily`, `modelVariantFlags`, `snapshotBase`, `TIER_PRICE_BANDS`; cached 24h in `system_cache` by `getCachedOpenRouterCatalog` | Price source for the suggested weight; family source for succession. Gains `permaslug`. |
| Schema bounds | `tier_pools.incumbent_floor`, `exploration_cap`, `challenger_min`, `max_step`, `auto_shift` | Stop being read. Dropped one release later (§7). |
| Cron | `/api/cron/tier-pools` is specified in the pools design §7 but **not built** | Built here, with the allocate, popularity and succession steps. |
| Registry | One row per `(team, workspace, tier)`; sibling task 201e7783 adds a nullable `surface` | Assumed surface-keyed: a pool's incumbent is its surface's row. |

## Proposal

### The crux

**Weights and signals are inputs. The allocation is still the only thing the
draw reads, and it changes only as a new version with an actor and a cause.**

An admin's weight change, a buildd explore step, a succession decay and a harm
cut all end in the same place: `writeAllocation` with a compare-and-set on the
version and a change row. No signal reaches the draw any other way. Popularity
can never trigger a change alone (§4c). Once an arm has graded outcomes, its
own results outweigh every outside prior by construction (§4c).

If this is wrong, and signals were allowed to adjust shares at draw time (a
"popularity boost" multiplied into `pickArm`), we would lose the audit trail,
`propensity` would stop being the recorded share, and a model could gain
traffic because other people use it rather than because it did our work well.

### 1. Split mode: weights, not percentages

Each arm in a `split` pool carries a **weight level**:

| Level | Value |
|---|---|
| `off` | 0 |
| `low` | 1 |
| `med` | 2 |
| `high` | 3 |

**Normalization** (in code, `sharesFromWeights`; no model call):

1. Live arms are `status = 'active'`. Paused arms keep their stored level and
   get share 0.
2. `W = Σ value(level)` over live arms. `W = 0` is rejected: at least one live
   arm must be above `off`.
3. Exact share `s_i = value_i / W`.
4. Stored shares are basis points (1e-4, matching `validateAllocation`'s
   rounding) by **largest remainder**: floor every `s_i · 10000`, then hand the
   leftover points one each to the largest fractional parts, ties broken by
   `armOrder` (incumbent first, then by `added_at`). Stored shares sum to
   exactly 10000.
5. The displayed percentage is computed the same way at whole-percent
   precision, so the numbers on screen always add up to 100.

Examples:

| Weights | Shares |
|---|---|
| high + low | 75 / 25 |
| high + med | 60 / 40 |
| med + med | 50 / 50 |
| high + med + low | 50 / 33 / 17 |
| high + med + med + low | 38 / 25 / 25 / 12 (stored 3750 / 2500 / 2500 / 1250) |
| high + off | 100 / 0 |

**The admin's weights are final in split.** No `incumbentFloor`, no
`explorationCap`, no `challengerMin`. The incumbent may be `off`. Eligibility,
freeze, the budget cap and the harm cut still apply (pools §6). A harm cut sets
the arm's level to `off`, writes its own version and names itself as the actor.
Nothing else in split changes a weight.

**Storage.** `tier_pools.weights jsonb {armId: level}` sits next to
`allocation`, and one `writeAllocation` statement writes both, so they can
never disagree. `allocation` stays the source the draw reads. A pool created
before this change has `weights = {}`. It is read through `nearestWeights`
(§3d) for display, and its allocation is untouched until an admin changes a
weight. Nothing moves on deploy.

**API.** `PATCH /api/model-tiers/pools/[id]` takes
`{ teamId, expectedVersion, weights?: {armId: level}, mode? }`. The server
computes the allocation. The raw `allocation` body field is removed: an admin
never sends a percentage. The 409-on-stale compare-and-set is unchanged.

### 2. Suggested weight for a new arm

When an admin adds a challenger, the add sheet presets the weight control to a
suggestion, and the admin can change it before `[Add]`. The arm is inserted
with the chosen level and the new allocation is written in the same
statement, as one version with `kind = 'arm_added'`. It no longer lands at 0%
and needs a second edit.

**Price source.** The OpenRouter catalog (`/api/v1/models`, the keyless feed
`normalizeCatalog` already parses), read through `getCachedOpenRouterCatalog`
and looked up with `priceFromCatalog`. The same model on two routes has the
same list price, so route does not enter the rule. Subscription runner arms
use the same list price: `MODEL_WEIGHTS` pacing units are list-price ratios
already, so the ranking agrees.

**Rule** (`suggestWeight`, pure):

```
blended(m)  = (3 · input + output) / 4          USD per MTok, from the catalog
ratio       = blended(challenger) / blended(incumbent)

ratio > 1.25            → low      pricier
ratio ≤ 1.25            → med      comparable or cheaper
either price unknown    → low      unknown is treated as pricier
```

- The incumbent is the pool surface's registry row (surface-keyed, per sibling
  task 201e7783).
- `high` is never suggested. Only a person puts a new arm on equal or greater
  footing with the incumbent's default `high`.
- 1.25 marks "comparable". A model a quarter pricier than the incumbent is in
  the same bracket; a model half again as pricey is not.
- The suggestion and its inputs are written into the change row's evidence:
  `{ suggestedWeight, chosenWeight, ratio, priceSource: 'openrouter-catalog', catalogAsOf }`.

### 3. Explore mode: buildd-controlled

`explore` is the admin's opt-in to buildd moving traffic. **Choosing explore
is the auto-shift opt-in.** The pools design's separate `auto_shift` flag is
retired. The bounds are code constants in one versioned policy object
(`EXPLORE_POLICY`, `version: 1`), not admin settings, and every allocation
records the policy version it ran under.

Promotion is unchanged: taking the incumbent below the explore floor, or
replacing it, is always an admin click with the evidence in pools §6.

#### 3a. Learning period

An arm is **learning** until all of the following hold. They are pools §5e,
unchanged:

- `graded ≥ MIN_GRADED_UNITS[surface]` (agent 30, chat 50);
- the spread condition (agent ≥ 5 distinct missions or tasks; chat ≥ 10
  conversations and ≥ 3 users);
- ≥ 7 days since the arm joined;
- grading health is OK.

While an arm is learning, its share is **fixed at `LEARN_SHARE = 0.10`**.
Outcomes do not move it. Only the harm cut (pools §6), freeze, the budget cap
or expiry (§4b) can change it. With the four-arm cap, learning challengers
hold at most 0.30 together, so the incumbent keeps at least 0.70 while every
challenger is new.

#### 3b. Relaxation by stage

Past learning, the bounds widen in discrete stages. The stage is set by the
arm's graded count `g` against `M = MIN_GRADED_UNITS[surface]`:

| Stage | Condition | Challenger share range | Max move per daily step |
|---|---|---|---|
| learning | §3a not met | exactly 0.10 | none |
| 1 | `M ≤ g < 2M` | 0.05 – 0.25 | 0.10 |
| 2 | `2M ≤ g < 4M` | 0.05 – 0.45 | 0.15 |
| 3 | `g ≥ 4M` | 0.05 – 0.70 | 0.20 |

- **Incumbent floor in explore: 0.20.** Challengers together are capped at 0.80.
- `g` counts graded units since the arm joined under the pool's current
  `policyVersion`. It is cumulative, not windowed, so an arm never drops a
  stage because traffic was quiet.
- The stage table is a step function on purpose. The evidence row can say
  "stage 2", and a reader can check it against n.
- A challenger held at the 0.05 minimum for 14 consecutive daily steps gets a
  `suggestion` row to remove it. buildd never removes an arm itself, except
  the auto-challenger's 30-day expiry (pools §3).

#### 3c. The daily step

Once per pool per day (pools §7, the team's local 06:00), in
`/api/cron/tier-pools`:

1. **Posterior.** For each live arm, `Beta(α, β)` with
   `α = α₀ + Σ w·q` and `β = β₀ + Σ w·(1 − q)` over graded units. `q` comes
   from `QUALITY_BY_SEVERITY` and `w` from pools §5d; P1 rows use `w = 1`.
   Priors: challengers `α₀ = β₀ = 1` plus the popularity pseudo-counts (§4a).
   The incumbent's prior is its last 30 days on the pool (pools §3).
2. **Target.** `P(arm is best)` from 10,000 Thompson draws per arm. The PRNG is
   seeded with `hashUnitInterval(`${poolId}:${policyVersion}:${yyyy-mm-dd}`)`,
   so a step replays exactly from its stored inputs.
3. **Caps.** Each arm's stage range (§3b), then the succession and expiry caps
   (§4b), then the incumbent floor.
4. **Harm cut** (pools §6) overrides to 0.
5. **Project** the target onto the caps (clamp, renormalise, repeat until
   stable, ≤ 10 passes), then limit each arm's move to its stage's max step.
6. **Quantize** to `QUANTUM = 0.05` by largest remainder (ties by
   `armOrder`). Learning arms keep exactly 0.10.
7. **Write only if the quantized allocation differs from the current one.** A
   day with no visible change writes nothing, so versions track real moves,
   not noise.

#### 3d. Weights ↔ shares across modes

- **Split → explore.** The current shares are projected onto each arm's
  stage bounds (learning arms go to 0.10) and quantized. One version,
  `kind = 'mode'`, actor = the admin.
- **Explore → split.** `nearestWeights(allocation)` picks the level vector,
  out of at most 4⁴ = 256 candidates, whose normalized shares have the
  smallest L1 distance to the current allocation. Ties go to the vector with
  fewer `off` levels, then to the one that is lexicographically higher in
  `armOrder`. The allocation is then re-derived from those weights, since the
  admin's weights are final in split. One version, `kind = 'mode'`, with both
  the prior shares and the snapped weights in evidence.
- **In explore the weight control shows `auto`.** Admins see the computed %
  and the last change. Levels are not stored while in explore.

### 4. External signals: priors, not overrides

#### 4a. Popularity (OpenRouter rankings)

**Source.** `GET https://openrouter.ai/api/v1/datasets/rankings-daily`. It
returns up to 51 rows per period: the top 50 public models by
`prompt_tokens + completion_tokens`, plus one `other` row. The fields are
`date`, `model_permaslug` and `total_tokens` (a string), with
`meta.as_of`, `start_date`, `end_date` and `version`. It needs any valid
OpenRouter API key and is rate-limited to 30 requests per minute per key and
500 per day per account.

**Views** (the exact and sampled datasets cannot be combined in one request):

| Surface | Request | Grain |
|---|---|---|
| agent | `modality=tool_calling` | daily, exact |
| agent | `category=programming` | weekly, sampled (`period=day` is rejected) |
| chat | `modality=text` | daily, exact |

Per-task views fit the agent surface better than overall usage. Overall
tokens are dominated by roleplay and long-context chat, which say nothing
about tool-driven coding work.

**Cadence.** One fetch per view per team per day, in the first
`/api/cron/tier-pools` run after 03:00 UTC (the dataset's `as_of` for the
previous day lands around 02:00 UTC). The window is the trailing 28 days
(`start_date = end_date − 27`). That is at most 3 requests per team per day.
A failed fetch is not retried that day. Stored scores older than 7 days are
ignored, and every arm then gets the neutral prior.

**Gate and key.** A team fetches only if it has at least one `explore` pool
and an OpenRouter `inference_key` resolves (`resolveInferenceCredential` at
team scope). Storing a key starts nothing, which matches
`inference-policy.ts`. Each team fetches with **its own** key, and its scores
feed only its own pools. No tenant's credential serves another tenant, and a
team without an OpenRouter key gets the neutral prior.

**Mapping permaslugs to our ids.** `model_permaslug` is OpenRouter's
`canonical_slug` (for example `anthropic/claude-3.5-sonnet-20241022` in their
docs). `normalizeCatalog` reads `canonical_slug` but keeps only a
native-ized `canonicalId`, so `CatalogEntry` gains `permaslug: string` (the raw
`canonical_slug`, else the OpenRouter `id`). Resolution:

1. catalog entry with `permaslug === model_permaslug` → its native `id`;
2. else the entry with `openRouterId === model_permaslug`;
3. else unmapped. Unmapped rows are dropped and counted in the cron's
   `changed` metric. `other` is never mapped and is used only as the
   denominator.

An arm's model matches a mapped id the way `priceFromCatalog` matches (exact
id, then `canonicalId`, then `snapshotBase`). Popularity belongs to the
model, not the route, so the Anthropic-key arm and the OpenRouter arm of the
same model get the same score.

**Score.** Rank within each view over the window, by summed tokens. Ranks are
used, not token counts, because OpenRouter notes that token counts come from
each provider's own tokenizer and are not comparable across providers. The
percentile is `pctile = 1 − (rank − 1) / 50`, and a model outside the top 50
scores 0. For the agent surface the score is the mean of its two views.

**Prior.** Four pseudo-units at most:

```
m  = 0.5 + 0.1 · (pctile − 0.5)        ∈ [0.45, 0.55]
α₀ += 4 · m      β₀ += 4 · (1 − m)
```

The gap between the most and least popular arm is 0.4 pseudo-successes. That
is less than one graded unit, and under 1.5% of the evidence an arm holds
when it leaves learning (30 or 50 graded units). Popularity measures
adoption, not quality, and the prior is sized to match.

**Storage.** One `system_cache` row per team and view, keyed
`or-rankings:v1:<teamId>:<view>`, holding
`{ asOf, startDate, endDate, scores: { <our model id>: pctile } }` and expiring
after 7 days. Raw rows and token counts are not stored.

**Licence.** The dataset is CC BY 4.0: reuse and republication are allowed
with the citation "Source: OpenRouter (openrouter.ai/rankings), as of
{as_of}." **Our policy is stricter: we do not re-serve it.** No API, MCP
action, export, UI or change-log response returns rankings rows, ranks or
percentiles. They are used only inside the allocate step. Change-row evidence
records `{ signal: 'popularity', view, asOf }` and the per-arm prior mean `m`
for replay, and the change-log API strips that field. If a future surface ever
shows a derived value, it must carry the citation line above.

#### 4b. Aging and family succession

**Family.** `modelFamily(id)` already maps `claude-sonnet-5` and
`claude-sonnet-5-1` to `anthropic:claude-sonnet`. It drops numeric tokens,
dates and preview words, and keeps size and variant words (`mini`, `pro`,
`codex`), which name a different product.

**Successor.** Catalog entry `s` succeeds arm model `a` (`findSuccessor`,
pure) when all of these hold:

1. `vendorOf(s.id) === vendorOf(a.id)` and `modelFamily(s.id) === modelFamily(a.id)`;
2. `versionTuple(s) > versionTuple(a)`. The tuple is the numeric tokens of
   `snapshotBase(id)`, compared lexicographically with zero padding:
   `claude-sonnet-5` = [5], `claude-sonnet-5-1` = [5, 1],
   `claude-sonnet-4-5` = [4, 5]. **If either id has no numeric token, there is
   no succession.** A later `created` alone is not enough, because re-listings
   and aliases also get new dates;
3. `day(s.created) > day(a.created)`, at the same day granularity
   `pickTierModel` uses;
4. `s` is not a preview (`modelVariantFlags`), is not deprecated, and is not a
   dated snapshot of the same base as `a`;
5. `s.contextLength ≥ MIN_CONTEXT_TOKENS`, and `s` is servable on the arm's
   route: a key for chat routes, `makeCatalogServabilityCheck` for runner
   routes;
6. `s.input` falls inside `TIER_PRICE_BANDS[tier]` for the pool's tier.

If more than one entry qualifies, the tie-break is the highest version tuple,
then the newest day, then the higher popularity percentile, then the shorter
id. That makes the choice deterministic.

**What happens.**

| Pool mode | Successor not in pool | Successor in pool (active) |
|---|---|---|
| `split` | `suggestion` row, `signal: 'succession'`. Weights untouched. | `suggestion` row. Weights untouched. |
| `explore` | If `auto_challenger` is on and the pool has < 4 arms, it is added at `LEARN_SHARE` (the P3 auto-challenger, `source = 'auto_challenger'`, actor `system:succession`, pools §3 bounds). Otherwise a `suggestion` row. | The old arm's cap decays (below). |

**Decay (explore only).** From the day the successor joins the pool, the old
arm's upper bound is multiplied by `0.5^(days / 14)`, a 14-day half-life:

- For a challenger, the cap applies to its stage range and bottoms out at
  0.05. When the multiplier falls below 0.1 (about day 47), a `suggestion` row
  proposes removing it.
- For the incumbent, the decay applies only to its share above the 0.20
  explore floor. Reaching the floor produces a promotion suggestion for the
  successor, if the successor meets pools §6. It never produces an automatic
  promotion.
- **Evidence halts decay.** Once both arms are past learning and
  `P(old beats successor) ≥ 0.9`, the multiplier freezes at its current value
  and the change row records `signal: 'succession_held'`.
- The step's max-move limit still applies, so decay is never faster than the
  stage allows.

**Expiry.** If the catalog's `expiresAt` for an arm's model is within 14 days,
that arm's cap goes to 0, reached through the normal max-move steps. In
`split` the arm's level goes to `off` on the expiry date as a system version
(actor `system:expiry`), because serving a model that no longer exists fails
every unit. That is the one automatic weight change in split, alongside the
harm cut.

#### 4c. How the signals combine

In the daily step, in this order:

1. **Evidence**: the arm's own posterior. It dominates once it exists (§4a
   sizing).
2. **Popularity**: pseudo-counts in the prior, at most 4 units.
3. **Stage caps**: evidence-gated room.
4. **Succession and expiry caps**: they only lower an arm's upper bound. They
   never raise one.
5. **Harm cut**: overrides to 0.

**Popularity never triggers a change.** After step 7 of §3c, the step is
recomputed with popularity pseudo-counts zeroed. If the result equals the
current allocation, meaning the only reason to move is popularity, nothing is
written.

**Attribution is counterfactual, not asserted.** For each signal present
(popularity, succession, expiry, stage change), the step is recomputed with
that signal removed. A signal whose removal changes the quantized result is
listed in `causes`. The change row's `actor_system` is the highest-precedence
cause:
`system:harm-cut` > `system:expiry` > `system:succession` > `system:explore`
(evidence and stages). There are at most four arms and four signals, so the
recomputation is trivial.

### 5. Audit

Every write goes through `writeAllocation`, which gains `weights` and
`actorSystem`, and appends one `tier_pool_changes` row:

- `before` / `after`: `{ allocation, weights, mode, version }`.
- `actor_user_id` for an admin, or `actor_system` from the set
  `system:explore | system:succession | system:expiry | system:harm-cut | system:budget-cap | system:freeze`.
- `evidence`: `{ policy: 'explore-v1', seed, arms: { [armId]: { stage, g, alpha, beta, pBest, capBefore, capAfter } }, signals: [...], causes: [...] }`.
  `signals` holds one entry per signal present, each with its kind, the arm it
  touched, and `asOf` for catalog or rankings data.
- Suggestions (succession, removal, promotion) are `kind = 'suggestion'` rows.
  Nothing moves until an admin applies one.

Pools §6 notification rules are unchanged: every change row notifies, and
system changes batch into the daily digest. **Nothing switches silently.**

### 6. UI

Labels and values only. There is no explainer copy, rationale text or tooltip
anywhere on the pool rows or the add sheet.

Per arm:

```
claude-sonnet-5     Anthropic key     [ off | low | med | high ]    60%
qwen3-coder         OpenRouter key    [ off | low | med | high ]    40%
```

- The weight control is a four-segment control. The % is plain text, computed
  (§1 step 5), and never editable.
- In explore, the control is replaced by the value `auto`. In a pinned pool,
  there is no control.
- Per pool: the mode chip (`pinned`, `split`, `explore` or `frozen`) and the
  last change as `<actor> · <date>`. The actor is the admin's display name or
  one of `buildd · explore`, `buildd · succession`, `buildd · expiry`,
  `buildd · harm cut`, `buildd · budget cap`.
- The add sheet shows the same weight control, preset to the suggestion
  (§2), next to the price columns it already has.
- Removed: the `Total …% · base keeps at least … · others at most …` line,
  the number inputs, and the `%` suffix label.
- The change-log API returns the actor's display name instead of `'admin'`.

### 7. Data model

Additive first, then one clean-up migration after a release:

```
tier_pools
  + weights jsonb NOT NULL DEFAULT '{}'      -- {armId: 'off'|'low'|'med'|'high'}; split only
  ~ mode 'pinned'|'split'|'explore'          -- unchanged column; explore now implies auto-shift
  - incumbent_floor, exploration_cap, challenger_min, max_step, auto_shift
                                             -- unread after W3/W7; dropped in W11

tier_pool_changes
  ~ before/after gain 'weights'; actor_system gains the values in §5   -- jsonb/text, no DDL
```

`EXPLORE_POLICY` lives in code. Its `version` goes into every evidence row, so
a later change of constants is visible in the log.

### Safety property

- **Defaults are no-ops.** Without a `tier_pools` row, nothing changes. An
  existing `split` pool keeps its exact allocation until an admin changes a
  weight. No pool enters `explore` unless an admin selects it. Rankings are
  fetched only for teams with an explore pool and an OpenRouter key.
- **Split is untouched by automation**, except the harm cut and expiry, which
  only reduce traffic to an arm.
- **Explore is bounded.** The incumbent stays ≥ 0.20. A challenger stays at
  0.10 until it has `MIN_GRADED_UNITS` graded units, and afterwards moves at
  most its stage's max step (0.10 – 0.20) per day, once per day. Popularity
  cannot trigger a move. Succession and expiry only lower caps. Promotion is
  always an admin click. There is one auto-challenger per pool at a time,
  removed after 30 days unless kept.
- **External fetches are bounded**: at most 3 rankings requests per team per
  day on the team's own key, with no retry loop.

## Open questions

1. **Level values 1/2/3.** `high + low` = 75/25 matches the brief. A 1/2/4
   ladder gives more separation (80/20) at the cost of less intuitive sums. I
   lean 1/2/3 because every common pair lands on a round number.
2. **Blended price weighting.** `(3·input + output)/4` assumes a 3:1 input to
   output mix. Agent runs are cache-read heavy, so input dominates even more.
   I lean to one formula for both surfaces. The rule only picks between
   `low` and `med`, and a finer model would move few decisions.
3. **Is explore = auto-shift too strong?** The pools design had explore with
   admin-applied suggestions. The brief says bounds are internal policy and
   buildd controls the mode, so I folded auto-shift into explore. The
   alternative is a third state, "explore, suggest only". I lean against it:
   one more mode to explain for a pool the admin already opted in.
4. **Incumbent `off` in split.** It is allowed, because the admin's weights are
   final. Ineligible units still serve the incumbent, so it keeps some
   traffic. I lean to allowing it rather than forcing `low`.
5. **Rankings on the team's key.** The dataset is public, and one platform
   fetch would serve everyone for 3 requests a day in total. That needs a
   platform-owned credential, which `secrets` has no purpose for today, and it
   shares one tenant-independent input across tenants. I lean to per-team
   keys: the cost is trivial, and it keeps "no tenant's credential serves
   another".
6. **Succession across routes.** A successor that exists only on OpenRouter
   while the arm is on the Anthropic key fails condition 5 for that route. I
   lean to not proposing a cross-route successor automatically. The admin can
   add it by hand.
7. **Half-life of 14 days.** It is long enough for a successor to leave
   learning at typical fleet volume before the old arm has lost most of its
   cap, and short enough that a stale model does not linger for a quarter. It
   should be revisited once real succession events have been logged.

## Non-goals

- **Per-surface base models.** Covered by sibling task 201e7783. This doc
  assumes the registry is surface-keyed.
- **Popularity in split mode, or in the suggested weight.** The suggestion is
  price only, and the admin's weights are final.
- **Showing rankings anywhere.** They are not re-served (§4a).
- **Per-draw adjustments.** The draw reads the allocation, as the pools crux
  requires.
- **Automatic promotion or automatic arm removal.** Both stay admin clicks,
  apart from the auto-challenger's 30-day expiry.
- **A model call anywhere in this doc.** Normalization, suggestion, family
  detection, stages and attribution are all deterministic code.

## Implementation breakdown

Ordered, with the load-bearing piece first. Each unit is one task and one PR.
`dependsOn` refers to the unit ids below.

| # | Unit | Paths (manifest) | dependsOn |
|---|---|---|---|
| W1 | **Weights core (pure).** `WEIGHT_VALUES`, `sharesFromWeights` (largest remainder, basis points), `displayPercents`, `nearestWeights` (L1 over ≤ 256 vectors), `blendedPrice`, `suggestWeight`. Tests: the §1 examples table, tie-break order, `W = 0` rejected, unknown price → `low`. | `packages/core/tier-weights.ts`, `packages/core/__tests__/tier-weights.test.ts`, `packages/core/package.json` (export) | — |
| W2 | **Schema: `tier_pools.weights`.** Additive jsonb default `{}`. Follow the schema-change skill. | `packages/core/db/schema.ts`, `packages/core/drizzle/**` | — |
| W3 | **Split by weights, end to end (server).** `writeAllocation` takes `weights` and `actorSystem`. `addChallenger` takes a level and writes arm + allocation + change row in one statement. `ensurePool` seeds `{incumbent: 'high'}`. The PATCH accepts `weights` and drops `allocation`. Split no longer applies `DEFAULT_POOL_BOUNDS`. The POST returns the suggestion from `getCachedOpenRouterCatalog`. The change-log GET returns the actor's display name. Route tests updated. | `packages/core/tier-pool.ts`, `packages/core/tier-pool-admin.ts`, `packages/core/__tests__/tier-pool.test.ts`, `packages/core/__tests__/tier-pool-admin.test.ts`, `apps/web/src/app/api/model-tiers/pools/route.ts`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts`, `apps/web/src/app/api/model-tiers/pools/route.test.ts` | W1, W2 |
| W4 | **Weights UI.** Four-segment control, read-only %, `<actor> · <date>`, add sheet preset, the `auto` value for explore. Removes the footer line and the number inputs. | `apps/web/src/lib/tier-pools-view.ts`, `apps/web/src/lib/tier-pools-view.test.ts`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.tsx`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.dom.test.tsx` | W3 |
| W5 | **Explore policy core (pure).** `EXPLORE_POLICY` (v1), learning test (§3a), stage table, seeded Beta/Thompson (`P(best)`), projection, max-step, quantize, no-change hysteresis, counterfactual attribution. Tests replay a step from stored inputs byte-for-byte. | `packages/core/tier-explore.ts`, `packages/core/__tests__/tier-explore.test.ts`, `packages/core/package.json` | W1 |
| W6 | **Catalog succession (pure).** `permaslug` on `CatalogEntry`, `versionTuple`, `findSuccessor` (§4b rules 1–6 and tie-break), `decayMultiplier`. Tests use `sonnet-5 → sonnet-5-1`, `4-5 → 5`, the unversioned-id case, preview/snapshot exclusion and the out-of-band case. | `packages/core/model-catalog.ts`, `packages/core/model-succession.ts`, `packages/core/__tests__/model-succession.test.ts`, `packages/core/__tests__/model-catalog.test.ts` | — |
| W7 | **Cron `tier-pools` with the explore allocate step.** Register in the manifest (hourly at :00; allocate at the team's local 06:00). Accept `mode: 'explore'` in PATCH with the §3d transitions. `poolEligibility` admits explore. Allocate reads `loadArmStats` counts. Harm cut in both modes. | `apps/web/src/app/api/cron/tier-pools/route.ts`, `apps/web/src/app/api/cron/tier-pools/route.test.ts`, `cron-manifest.json`, `packages/core/tier-pool.ts`, `packages/core/tier-pool-admin.ts`, `packages/core/tier-pool-source.ts`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts` | W3, W5 |
| W8 | **OpenRouter rankings.** Pure parser and permaslug mapping, a source that fetches the three views on the team's key and writes `system_cache`, and the fetch step in the cron (after 03:00 UTC, gated on explore pool + key). Tests: mapping, `other` row, stale > 7 days → neutral, a 400/401/429 → no write. | `packages/core/openrouter-rankings.ts`, `packages/core/openrouter-rankings-source.ts`, `packages/core/__tests__/openrouter-rankings.test.ts`, `apps/web/src/app/api/cron/tier-pools/route.ts` | W6, W7 |
| W9 | **Wire signals into allocate.** Popularity pseudo-counts, succession detection (suggestion or auto-challenger), decay and the evidence halt, expiry (including split's `off` on the expiry date), the popularity-never-triggers check, and the stripping of popularity fields from the change-log API. | `packages/core/tier-explore.ts`, `packages/core/tier-pool-admin.ts`, `apps/web/src/app/api/cron/tier-pools/route.ts`, `apps/web/src/app/api/model-tiers/pools/[id]/route.ts`, `packages/core/__tests__/tier-explore.test.ts` | W7, W8 |
| W10 | **Explore UI bits.** The mode chip gains `explore`, the actor labels for `system:*` and suggestion rows on the pool row. Labels and values only. | `apps/web/src/lib/tier-pools-view.ts`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.tsx`, `apps/web/src/app/app/(protected)/settings/models/TierPoolsSection.dom.test.tsx` | W4, W9 |
| W11 | **Retire bound columns.** Drop `incumbent_floor`, `exploration_cap`, `challenger_min`, `max_step` and `auto_shift` one release after W7 ships, following the schema-change skill's drop procedure. Remove `DEFAULT_POOL_BOUNDS` and the bound arguments of `validateAllocation`. | `packages/core/db/schema.ts`, `packages/core/drizzle/**`, `packages/core/tier-pool.ts`, `packages/core/__tests__/tier-pool.test.ts`, `apps/web/src/lib/tier-pools-view.ts` | W7, W9 |
| W12 | **Close the loop in docs.** Update `docs/SPEC.md` "Model tiers" when W4 ships. Set this doc and the pools doc to Implemented when W10 lands. | `docs/SPEC.md`, `docs/design/tier-weights.md`, `docs/design/tier-model-pools.md` | W4, W10 |

W1, W2, W5 and W6 can run in parallel. W3 → W4 delivers the whole
split-by-weights change on its own, without waiting for explore.
