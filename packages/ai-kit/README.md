# @buildd/ai-kit

Shared chat contract, tool permissions, model plans and Jev decisions for apps
that use [buildd](https://buildd.dev)'s model economy.

buildd decides **which model** a call uses and **whether it may spend**. Your
app makes the call with its own provider key and reports a content-free usage
record. buildd never sees prompts, tool results or replies.

```sh
npm i @buildd/ai-kit@0.1.0
```

Pin exact versions: a Jev model bump or a contract change is a new kit release,
and you should re-run your evals before taking it.

## Entry points

| Import | What | Status |
|---|---|---|
| `@buildd/ai-kit/chat/contract` | Wire types: parts, object refs, data parts, approval previews, tool-permission rows. No deps, isomorphic | Ready |
| `@buildd/ai-kit/chat/server` | `defineToolGroups` + server-side Allow enforcement. Turn runner later (peer `ai@^7`) | Permissions ready |
| `@buildd/ai-kit/chat/react` | UI components (peers `react@^19`, `@ai-sdk/react@^4`) | Types only |
| `@buildd/ai-kit/chat/theme.css` | `--kit-*` CSS custom properties. No Tailwind | Ready |
| `@buildd/ai-kit/models` | Model-plan client + usage sink. No deps; Node, Bun, edge | Ready |
| `@buildd/ai-kit/decide` | Jev decisions: typed questions, gating, versioning, eval (peer `@typesafe-ai/sdk`) | Ready |
| `@buildd/ai-kit/surfaces` | Jev picks among the app's own chips and cards | Types only |

## Model plans

Ask buildd which model to call and whether it may spend; make the call with
your own key; record a content-free receipt.

```ts
import { createModelsClient, toCallConfig, isPlanDeniedError } from '@buildd/ai-kit/models';

const models = createModelsClient({
  apiKey: env.BUILDD_AI_KEY,                // a bld_ key for the app's service account
  providers: ['openrouter'],                // provider keys the app holds
  defaults: {                               // used only when buildd is unreachable; every tier
    'premium-plus': { provider: 'openrouter', model: '<pinned id>' },
    premium:        { provider: 'openrouter', model: '<pinned id>' },
    standard:       { provider: 'openrouter', model: '<pinned id>' },
    budget:         { provider: 'openrouter', model: '<pinned id>' },
  },
  // storage: kvPlanStore,                  // optional: survive cold starts (get/set of JSON)
});

try {
  const plan = await models.plan({ tier: 'standard', kind: 'chat_turn', budget: { maxUsdPerCall: 0.02 } });
  const cfg = toCallConfig(plan, { apiKeys: { openrouter: env.OPENROUTER_API_KEY }, appName: 'cue' });
  // ... call cfg.model at cfg.baseURL ...
  models.recordUsage({ plan, tokens: { input, output }, costUsd, latencyMs, outcome: 'ok' });
} catch (e) {
  if (isPlanDeniedError(e)) { /* show e.reason: daily_cap_reached, per_call_limit, ... */ }
}
await models.flush(); // before a serverless function returns (e.g. in waitUntil / after)
```

- **Caching.** Plans are cached per (tier, surface, workspace, budget) until
  buildd's `expiresAt` (60s). Concurrent callers share one request.
- **Bounded fallback.** buildd slower than 800ms, a 5xx, a network error or an
  unusable answer: the last good plan is served for up to `maxStaleSeconds`
  (24h) past expiry with `planSource: 'cached'`, then your `defaults` with
  `planSource: 'fallback'` and `planId: null`. `plan()` never blocks longer
  than the deadline and throws only `PlanDeniedError`.
- **Budget.** `deny` throws `PlanDeniedError`; `downgrade` returns the cheaper
  model as buildd sent it (`plan.tier` ≠ `plan.requestedTier`).
- **Receipts.** `recordUsage` never throws. It rebuilds each record from the
  server's allowlist (plan id, model, provider, tier, kind, planSource, tokens,
  cost, latency, outcome, feedback), so nothing else you pass can reach buildd, and
  refuses locally what buildd would reject. Batches of ≤100, one retry on a
  network error / timeout / 5xx / 429, then dropped and counted in `stats()`.
  Optional `kind` (`chat` | `inference` | `decision`) lets buildd report spend
  by kind; a `decision` receipt needs no tier.
- **Storage.** `PlanStore` is `{ get(key), set(key, value) }`, sync or async.
  A failing store is treated as a miss. Default: in memory.
- `onError` receives every absorbed failure, for logs.

## Tool permissions

Declare your tool groups once. The same declaration drives the tools menu,
the per-person preference and server-side enforcement.

```ts
import { defineToolGroups } from '@buildd/ai-kit/chat/server';

export const groups = defineToolGroups({
  notes:  { label: 'Notes',  tools: [{ name: 'create_note', class: 'write' }], modes: ['ask', 'allow'] },
  search: { label: 'Search', tools: [{ name: 'search', class: 'read' }],       fixed: 'read' },
  keys:   { label: 'Keys',                                                     fixed: 'never' },
});

groups.rows(groups.parseAllowed(storedPreference)); // menu rows; badge = allowedBadgeCount(rows)

// In your tool-approval hook:
if (groups.canSkipCard({ tool, input, allowedGroups, tainted, docked, skippedThisTurn })) {
  // still build the same preview a card would, and skip only if it resolves
}
```

- `ask`: every write gets an approval card (the default for every toggleable group).
- `allow`: a write may skip its card, only if it is the first skip of the turn,
  no tool output is in the model's context, nothing is docked, it starts no
  unattended work and doesn't spend, and its input carries only skippable fields.
- `read`: no write tools (declaring one throws at startup).
- `never`: not a tool at all; shown as a locked row.

## Jev decisions

Jev (TypeSafe's System One model, via OpenRouter) picks one of your labels,
scores an ordered rubric or answers yes/no, with calibrated probabilities. It
never writes text. Use it as an accelerator in front of logic you already
have, never as the only source of an answer.

```ts
import { choice, noul, defineDecision, expectDecisionPinned } from '@buildd/ai-kit/decide';

export const emailTriage = defineDecision({
  id: 'cue.email_triage',
  promptVersion: '2026-09-27.a',          // bump when anything below changes
  questions: {
    bucket: choice('Which bucket?', { actionable: '…', informative: '…', noise: '…' }),
    concerning: noul('Does it report a failed payment or account problem?'),
  },
  mode: 'shadow',                          // default for every question
  modes: { concerning: 'live' },           // an add-only hold can act now
  minConfidence: { concerning: 0.6 },      // required for every 'gated' question
});

const run = await emailTriage.run({ apiKey: openRouterKey, state: { from, subject, body } });
if (run.outcomes.concerning.status === 'applied' && run.outcomes.concerning.value) holdForTriage();
// run.version is `promptVersion|model|kit-<version>`: stamp it on every row you persist.

// Many states (one per request) with ~8 workers and one run budget:
const { items, stats } = await emailTriage.runEach(emails, { apiKey, stateOf: toState, budgetMs: 10_000 });
```

- **Outcomes** per question: `applied` (act on `value`), `suggested` (shadow,
  or below the threshold) or `skipped` (the call failed; fall back).
- **Modes**: `shadow` never applies; `gated` applies at or above the
  question's threshold; `live` applies at or above the threshold if one is set.
  A noul's confidence is `max(p, 1 - p)` and its value `p >= 0.5`.
- **Transport** (`decide`): never throws; one deadline (default 5s) over every
  attempt; retries 408, 429 and 5xx once by default. The SDK's own retry is off
  and every SDK option is explicit, so no `TYPESAFE_*` env var can redirect the
  key. The kit never reads env vars: pass your OpenRouter key.
- **Model**: `JEV_MODEL` is pinned (not `~typesafe/jev-latest`) and is not a
  tier. A Jev bump is a kit release; re-run your eval before taking it.
- **Versioning**: pin the fingerprint in a test. It covers the questions,
  modes, thresholds and model, so a changed definition fails until you bump
  `promptVersion` and re-pin:

  ```ts
  it('is pinned', () => expectDecisionPinned(emailTriage, { fingerprint: '3f1c…' }));
  ```
- **Eval**: `runDecisionEval({ decision, rows, stateOf, labelOf, idOf, split: 'even-odd', run: { apiKey } })`
  reports accuracy, coverage and accuracy at each threshold, per-label
  precision/recall, confusions, cost per 1k and latency. Tune on one half,
  judge on the other, and read thresholds off the held-out table. Keep your
  labelled rows out of git.
- **Receipts**: `onUsage` gets a metadata-only `DecisionReceipt` per call
  (model, tokens, cost, latency, outcome). Send it on with
  `onUsage: r => models.recordUsage(toModelsUsage(r))`. It is sent as
  `kind: 'decision'` with no tier, so buildd reports decision spend on its
  own instead of as budget-tier chat.

Writing labels: define each one contrastively, avoid a catch-all label
("other"), keep state small, and leave arithmetic and dates to code.

## Theming

Import `@buildd/ai-kit/chat/theme.css` and override the `--kit-*` variables
with your own tokens.

## License

Apache-2.0
