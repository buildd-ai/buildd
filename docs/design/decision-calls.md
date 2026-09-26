---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# decision-client and task-category-shadow pass because steps 1-4 shipped
# (PRs #2823, #2829, #2830). gated-apply fails because step 6 has not. Status
# stays 'partially' until it does; the two passing assertions reading as
# code_ahead against 'partially' is expected, not drift. See "Implementation
# status" at the end.
assertions:
  - id: "decision-client"
    type: "symbol"
    name: "decisionCall"
    path: "packages/core/decision-client.ts"
  - id: "task-category-shadow"
    type: "symbol"
    name: "runTaskCategoryShadow"
    path: "apps/web/src/lib/task-category-decision.ts"
  # Tracks the remaining work (step 6): the first confidence-gated apply. Fails
  # until a site actually acts on a decision, which is what keeps this doc at
  # 'partially' honestly.
  - id: "gated-apply"
    type: "symbol"
    name: "applyTaskCategoryDecision"
    path: "apps/web/src/lib/task-category-decision.ts"
---
# Decision Calls: a Third Primitive for Fixed-Label Judgments

**Status:** Partially implemented. Steps 1–4 have shipped: the client, the policy wiring, the offline benchmark and the `classifyTask` shadow. Step 6, the first confidence-gated apply, has not, so nothing acts on a decision yet. See "Implementation status" below.
**Related:** `docs/design/inference-calls-primitive.md` (which this extends), `packages/core/inference-client.ts`, `packages/core/inference-policy.ts`, `packages/core/decision-client.ts`, `packages/core/inference-keys.ts`, `packages/core/decision-benchmark.ts`, `apps/web/src/lib/task-category.ts`, `apps/web/src/lib/task-category-decision.ts`, `scripts/decision-benchmark.ts`, `docs/credentials-architecture.md`, `docs/design/model-tiers.md`, `docs/design/agent-chat.md`

---

## Problem

Buildd makes a lot of decisions of the form "which of these fixed labels fits this text?". None of them has a good tool.

- **Keyword regexes** are what most sites use. `classifyTask` (`apps/web/src/lib/task-category.ts:66`) returns the first category whose regex matches. So "Rewrite the testing guide" becomes `test`, not `docs`, because `test` comes before `docs` in `CATEGORY_ORDER` and `\btest` matches "testing". The function also has keywords for `review` but leaves it out of `CATEGORY_ORDER`, so it can never return that label. A regex has no confidence, so the caller cannot tell a clean match from a coincidental one.
- **`inferenceCall`** (`packages/core/inference-client.ts`) is the only other supported path. It runs a generative model and extracts JSON. That is the wrong shape for "pick a label":
  - it costs a generative model's price;
  - latency is measured in seconds;
  - the answer has to be parsed out of prose;
  - the model can return a label outside the set;
  - it gives no calibrated uncertainty, only whatever the model says.

  The inference doc states the rule "if it fits in one prompt, use an inference call". That rule sends every label decision down the expensive path.

A System One model returns a typed answer instead of text. Jev, by TypeSafe, is one, and it is served through OpenRouter as `typesafe/jev-1.13`. For a Choice question it returns the chosen label, the full probability distribution and a `confidence` value. The label is always one of the options the caller supplied. Its published input price is a few cents per million tokens, and output tokens are free. Buildd has no way to call such a model, no policy for when to, and no way to find out whether it beats the regex on buildd's own tasks.

## Proposal

Add a `decisionCall` primitive next to `inferenceCall` in `packages/core`. Then make the only permitted adoption path this sequence: **shadow → offline benchmark on held-out labelled data → confidence-gated apply, with fallback to the logic that already exists.**

### The crux

**A decision call may only ever be an accelerator in front of existing logic, never the sole source of an answer.**

Every call site that adopts decision calls keeps its current logic and falls back to it:

- when the call fails (timeout, missing key, disabled, provider error);
- when confidence is below that site's threshold.

Suppose this is wrong and a site depends on the model:

- a provider outage, an alpha endpoint change or an exhausted OpenRouter balance breaks the feature outright, instead of making it slightly worse;
- a "catch-all" label that quietly absorbs unfamiliar input would ship straight into stored state.

The fallback rule is what lets the thresholds be aggressive. The shadow-first rule is what lets anyone know the threshold is right.

### Point 1: The primitive

`packages/core/decision-client.ts`:

```typescript
decisionCall<Q extends DecisionQuestions>({
  capability,          // InferenceCapability — the team allowlist key, checked first
  teamId, workspaceId?, accountId?,
  state,               // string | object | array — keep it small
  questions: Q,        // { name: ChoiceQuestion<L> | ScoreQuestion | NoulQuestion }
  model?,              // default 'typesafe/jev-1.13' (pinned; see Point 5)
  timeoutMs?,          // whole-call deadline across attempts, default 5s
}): Promise<DecisionResult<Q>>
```

- **Typed questions.** Three question types, matching the provider's API reference:
  - `choice`: criteria map each label to its definition, with 2–255 labels;
  - `score`: an ordered array of 2–10 levels;
  - `noul`: optional `true`/`false` descriptions.

  The answer map is keyed by the question names, and its types come from the question types. `answers.category.choice` has the type of the label union the caller declared.
- **Validated both ways.** The request is checked locally before any network I/O. That includes the label and level bounds and an estimated token ceiling, so an oversized state is refused for free. The response is checked too: a choice outside the caller's label set, a missing answer or a type mismatch is a `parse` error. It is never passed through as a new label.
- **Never throws.** The error kinds are `capability_disabled`, `missing_key`, `invalid_request`, `timeout`, `transport`, `rate_limited`, `provider_error` and `parse`. `latencyMs` and `attempts` are returned on both success and failure.
- **Transport.** The client uses the official MIT TypeSafe SDK (`@typesafe-ai/sdk`, pinned to an exact version) pointed at OpenRouter's System One API: `baseURL` `https://openrouter.ai/api`, to which the SDK appends `/v1/systemone`, with `{ model, state, questions }` and the OpenRouter key as the bearer token (see OpenRouter's TypeSafe SDK guide). The SDK owns the wire format and error classes. Buildd owns the rest:
  - **The SDK's retry is off** (`maxRetries: 0`). Its timeout is per attempt, with no total budget, so its default retry-with-backoff could hold a call open well past buildd's deadline, and it would stack on buildd's own retry. The single retry described under Point 3 is buildd's, and each attempt's SDK timeout is set to what is left of the deadline.
  - **Every SDK option is passed explicitly** (key, base URL, model, log level). Otherwise the SDK falls back to `TYPESAFE_*` env vars, and a stray `TYPESAFE_BASE_URL` would send a team's key to another host.
  - **`usage.cost`** is an OpenRouter addition outside the SDK's typed `Usage`. The SDK passes the parsed body through unchanged, so the client reads it defensively.
  - The SDK's model listing (`client.models.list()`) is incompatible with OpenRouter, according to the same guide. It is not used.
- **Lazy DB import.** The DB client, which imports `server-only`, is loaded only on the key-lookup path. Importing the module, or calling it with an explicit `apiKey` (the offline benchmark), works from a plain bun process.

### Point 2: Confidence gating and fallback

`gateChoice(answer, minConfidence)` returns one of two outcomes:

- `{ apply: true, label }`;
- `{ apply: false, reason, label?, confidence? }`. The losing label is kept, for logging.

The rules around thresholds:

- **Thresholds are per question and come from data.** Each is read off the coverage/accuracy table that `scripts/decision-benchmark.ts` prints for the held-out split. They are not round numbers.
- **The starting shape**, following the provider's confidence guidance:
  - auto-apply at or above a high threshold (around 0.9 for anything stored);
  - fall back to existing logic below it;
  - for sites where a wrong answer is costly, also queue the case for a human in between.
- **Thresholds do not transfer.** A threshold does not carry from one question to another. It never carries from a Choice to a Noul, because a Noul answer has no `confidence` at all.
- **A retune is a code change.** Every threshold lives next to the question definition, so changing one goes through review.

### Point 3: Timeouts and blast radius

- The deadline covers the whole call. The default is 5 seconds; the shadow uses 3.
- At most one retry, and only for transient failures: network errors, 429, 5xx, 529 and 524. The retry only starts if at least 500 ms of the deadline remains.
- 4xx responses other than 429 are never retried. That covers 400, 401, 402 (out of credit) and 413.
- The worst case is therefore bounded by `timeoutMs`, whatever the provider does.
- A decision call on a request path must be scheduled after the response with `after()`, or bounded well inside the path's own budget. The shadow does the former.

### Point 4: Credential

The key is an OpenRouter key stored in the `secrets` table under a new purpose, `decision_key`. There is **no new table**, following `docs/credentials-architecture.md`.

- `purpose` is a `text` column, so only the TypeScript unions changed: `packages/core/db/schema.ts` and `packages/core/secrets/types.ts`. No migration.
- An existing `inference_key` row labelled `openrouter` is accepted as a fallback, so a team that already stored an OpenRouter key for `inferenceCall` does not paste it twice.
- A key must never go to a provider it was not issued for. Rows with any other purpose, or `inference_key` rows labelled for another provider, are rejected in JS even if the query returns them.

**Since agent chat P1**, `resolveDecisionKey` is a thin wrapper over the shared `resolveInferenceKey` (`packages/core/inference-keys.ts`), so one OpenRouter key serves chat, inference and decision calls. `decision_key` stays preferred over `inference_key` at the same scope, and a personal key (`secrets.userId`) ranks first when the call names the acting user.

**Resolution order: acting user → acting account → workspace → team.** A personal row whose `userId` equals the caller wins, then an account-scoped row whose `accountId` equals the caller's account, then a workspace-scoped row, then the team-wide row. Rows scoped to *another* user, account or workspace are never considered. The full order, including the legacy account-row and env steps, is documented at the top of `packages/core/inference-keys.ts`.

This intentionally differs from the credentials doc's workspace → account → team order. That order is for runner credentials; the order here is for a key that a person pays for. If a user has brought their own key, that key should be the one spent (Open Question 1).

**Env.** `OPENROUTER_API_KEY` is used only when `NODE_ENV !== 'production'`, for local development and the benchmark script. In production the key must come from `secrets`, so a stray deployment env var can never start spending on every team. The guard is `envKeysAllowed()` in `packages/core/inference-keys.ts`, so since the shared resolver landed it covers `inferenceCall` and chat too. A self-hosted deployment can opt back in with `BUILDD_ALLOW_ENV_INFERENCE_KEYS=1`.

**Storage.** `POST /api/secrets` accepts `decision_key` as a raw-string purpose, strips wrapping quotes, and applies no prefix rule. Like `mcp_credential` and `inference_key`, it is stored **team-wide by default**. Every other purpose defaults to the calling API key's account, which would quietly make a team's key work only for tasks filed by that one account.

### Point 5: Model selection

- The client **pins** `typesafe/jev-1.13` rather than `~typesafe/jev-latest`. Thresholds are tuned against one version, and an alias can move under them.
- The response's versioned `model` (for example a dated `jev-1.13-…` snapshot) is carried on every result and logged next to every shadow record.
- To bump the version, re-run the benchmark, re-read the thresholds and change the constant.
- Decision models are **not** in the tier registry. The registry maps a quality tier to a generative model, and a decision call is not a quality level of the same thing. Putting both in one registry would let someone point a `budget` tier at a model that cannot generate text.

### Point 6: Cost accounting

- The provider returns `usage.cost` in USD on every response. The client surfaces it as `usage.costUsd`, or `null` when it is absent. No price is hardcoded, because a hardcoded price goes stale.
- Output tokens are free, and a well-formed shadow call is a few hundred input tokens. At the published per-token price, one shadow call costs a small fraction of a cent.
- Attribution follows the inference doc's decision: team level only, not persisted per call for now. Every shadow record carries `costUsd` and `inputTokens`, so the log alone can produce a spend total.
- Spend is gated like inference spend: the team's `enabledInferenceCapabilities` allowlist is checked before the key is resolved. The default is empty, so storing a key changes nothing.

### Point 7: Decision call vs inference call — the policy

Use a **decision call** when all of these are true:

- the output is one label from a fixed set of at most 255 (or a yes/no, or an ordered 2–10 level score);
- the input can be reduced to a small, relevant state (a title and description, a handful of fields);
- a wrong answer can be caught by a confidence gate plus fallback;
- there is, or can be collected, labelled data to benchmark on.

Use an **inference call** when:

- the output is generated text (a summary, an explanation, a PR body);
- it is extraction of free values (amounts, dates, names);
- the judgment needs long, noisy evidence. Jev's accuracy falls as irrelevant state grows, and its limit is 32K tokens for the state plus the longest question;
- the judgment needs multi-hop reasoning.

Use **code** for the following. The provider's own "jaggedness" notes list these as weak spots:

- arithmetic;
- date comparison;
- counting;
- anything already computable from structured fields.

Rules for writing label sets. These come from the provider's guidance plus its jaggedness notes, and each one is enforced by review, not code:

1. **Definitions matter more than the model.** Write each label contrastively: what it covers, and what it is not for. `TASK_CATEGORY_QUESTIONS` shows the shape.
2. **No catch-all label** ("other", "general"). A catch-all absorbs unfamiliar inputs and inflates apparent accuracy. "Nothing fits" should show up as low confidence, and the gate handles it.
3. **Overlapping labels hurt, and thresholds do not fix them.** If two labels are confused on the benchmark, reword them or merge them.
4. **Tell the model to follow the definition when examples or keywords conflict.** Jev reads literally.
5. **Do not add a yes/no question on top of a choice** to "confirm" it. The two are not calibrated against each other, and the extra question does not help.
6. **Always evaluate on a held-out split of your own labelled data.** Tune wording on `--split train`, and judge on the default held-out split.

### Point 8: Inventory of buildd call sites, ranked by fit

Ranked by fit for a decision call: a fixed label set, short text input, a cheap-to-gate error, and a working fallback.

| Rank | Site | Today | Labels | Cost of a wrong answer | Verdict |
|---|---|---|---|---|---|
| 1 | Task category: `classifyTask`, `apps/web/src/lib/task-category.ts:66`, called from `POST /api/tasks` | Ordered keyword regex; returns null when nothing matches | `bug feature refactor chore docs test infra design review research` | Low. Mostly a display tag. `review` changes claim pacing and reviewer handling, and the regex never emits it today. `research` is emitted only from the title's opening verb or prefix, never from a word in the description. | **Best fit. Shadowed now (Point 9).** |
| 2 | Task routing kind/complexity: `inferRouting`, `packages/core/task-routing-preview.ts:128` | Title prefix, manifest size, sensitive paths, description length | kind (`coordination`/`engineering`/…), complexity `simple/normal/complex` | Medium. Picks the model tier, so the result is cost, not correctness. | Good fit for complexity, as a Choice or Score over the description. Keep the manifest and sensitive-path rules in code, because they are exact. |
| 3 | Coordination intent: `classifyCoordinationIntent`, `apps/web/src/lib/coordination-intent.ts:25` | Keywords on the plan step title | `wait aggregate merge verify` or null | Medium | Good fit, with short input. Gate high, because it changes orchestration. |
| 4 | Role routing: `tasks.roleSlug`. Nothing infers it today (`POST /api/tasks` stores only what the caller sends; the planner copies its plan). The claim filter is `apps/web/src/app/api/workers/claim/role-gate.ts`. | Caller or planner supplied | The workspace's roles (defaults in `apps/web/src/lib/default-roles.ts`, plus custom ones) | High. The wrong role gets the wrong prompt, skills and connectors, or the task is never claimed. | Fit as a **suggestion only**: pre-fill the role in the UI, or fill it when the caller left it empty and confidence is high. Labels are per workspace, so criteria come from role descriptions at call time. |
| 5 | Worker failure cause: `classifyFailure` (`apps/web/src/lib/failure-classifier.ts:15`) and `classifyReportedFailure` (`apps/web/src/lib/worker-exit-taxonomy.ts:109`) | Substring and regex on error text | `transient environmental logic budget_limited unknown`, and the `WorkerExitCause` set | Medium to high. Decides retry versus fail. | Only as an assist when the regex returns `unknown`. Error text is noisy, so trim it to the tail. |
| 6 | Friction and error grouping: `normalizeErrorSignature` (`packages/core/error-signature.ts:119`) and `failure-friction-signature.ts` | Regex canonicalisation, then a hash. Not a label set. | None; exact-match clustering | Medium. Duplicate or merged friction tasks. | **Poor fit as a classifier.** The possible fit is a Noul asking "are these two excerpts the same failure?" against the top few candidate signatures before a new friction task is filed. That is dedupe verification, a later design. |
| 7 | Criteria judge: `judgeWithLLM`, `apps/web/src/lib/mission-criteria-eval.ts:112` | `inferenceCall`, verdict `pass fail UNVERIFIED` | 3 verdicts | High. A false pass moves a mission toward completion. | **Poor fit today.** The evidence is long (task summaries plus artifact snippets), and a verdict is a multi-hop judgment. Revisit only for short, fixed-rubric criteria, as a Score, with the current judge as fallback. |
| 8 | Merge risk and auto-merge: `resolvePolicy` (`apps/web/src/lib/merge-policy.ts:126`), `detectAllRiskClasses` (`apps/web/src/lib/workspace-policy.ts:168`), `evaluateAutoMergeSafety` (`apps/web/src/lib/auto-merge.ts:103`) | Deterministic rules on paths, CI state and line counts | Policy `auto-threshold agent-review human`; risk classes `destructive_schema_change ci_deploy_config auth_and_secrets dependency_bump public_api_contract` | Highest. Code merges without a human. | **Do not replace.** The inputs are structured and the rules are exact. At most, a Noul over the PR description could *escalate* to review (never de-escalate), as an extra signal behind the rules. |
| 9 | Mission health: `deriveMissionHealth`, `apps/web/src/lib/mission-helpers.ts:659` | Ordered rules on structured fields | `active on-schedule stalled shipped paused idle budget-exhausted held escalated` | Low | **Not a fit.** There is no free text and the rules are exact. This is exactly the "use code" case. |
| 10 | Notification relevance: `resolveNotifyPlan` (`apps/web/src/lib/notify-rules.ts:56`) and hardcoded priorities in `apps/web/src/lib/mission-notifications.ts` | Per-event preference yes/no | None; there is no relevance scoring | Low | No site to replace. A future "is this worth a push?" Noul over the event text would be a new feature, and would need labelled read/dismiss data first. |

Other fixed-label classifiers of free text, for completeness. Each is regex- or substring-based, and each falls somewhere between ranks 3 and 6:

- `classifyAuthErrorSeverity` (`packages/core/auth-error-classifier.ts:53`). A wrong `revoked` kills a credential, so any assist must only ever *downgrade* the severity.
- `classifyMergeFailure` (`apps/web/src/lib/conflict-retry.ts:46`).
- `detectProseGate` (`packages/core/prose-gate.ts:75`).

### Upcoming uses: agent chat

These are for agent chat, designed in `docs/design/agent-chat.md` (Proposed), which adopts the tier and intent routing below. Each fits the policy above, because each is a short user utterance, a fixed label set and a cheap fallback:

- **Routing a request to a model tier.** A Choice over `simple / standard / complex`, fed the user's message plus minimal thread context. It maps onto the existing registry tiers (`budget / standard / premium`, `docs/design/model-tiers.md`).
  - Fallback: `standard`.
  - A wrong answer costs money or quality, not correctness, so the gate can be moderate. An asymmetric gate is also sound: auto-apply a *downgrade* only at high confidence, and an *upgrade* at lower confidence.
- **Classifying a remembered item into a memory tier.** A Choice over `directive / short-term / knowledge`.
  - The definitions must be contrastive: a directive is "an instruction about how to behave from now on"; short-term is "true for this conversation or task only"; knowledge is "a durable fact about the codebase or the world".
  - This is where a catch-all like "other" would be most tempting, and most harmful.
  - Below the gate, ask the user or default to short-term, the least durable tier.
- **Intent routing.**
  - First question: a Noul, "does answering this need tools?". Its threshold is tuned separately from any Choice threshold.
  - Second question: a Choice over the available tool groups.
  - Both go in one request against the same state, because questions are evaluated in parallel.
  - Below the gate, fall back to letting the generative model decide with all tools available.

## Implementation sketch

In order, load-bearing piece first:

1. **`packages/core/decision-client.ts`**: `decisionCall`, typed question/answer types, local validation, response validation, `gateChoice`, and `resolveDecisionKey`. Unit tests mock HTTP and assert the documented request shape (`packages/core/__tests__/decision-client.test.ts`). *Done.*
2. **Policy wiring.** A `task_category_shadow` capability in `packages/core/inference-policy.ts`. It renders in the existing Agent Backends settings toggle list, off by default. The `decision_key` purpose is added to the `secrets` unions and to `POST /api/secrets`. *Done.*
3. **Offline benchmark.**
   - `packages/core/decision-benchmark.ts` is pure: JSONL parsing, a deterministic held-out split, and accuracy/coverage at thresholds plus per-label precision/recall and a confusion matrix.
   - `scripts/decision-benchmark.ts` is the I/O half: it runs a question set with an env key and prints the incumbent's accuracy alongside.
   - The data lives in `.decision-data/`, which is gitignored.
   - *Done.*
4. **Shadow on `classifyTask`** (Point 9). *Done.*
5. **Read the shadow.** Collect `[decision-shadow]` lines, hand-label a sample of tasks into `.decision-data/task-category.jsonl`, run the benchmark, and pick the threshold. *Operator step.*
6. **Apply behind the gate.** Only after step 5: store Jev's category when `gateChoice` clears the threshold, and keep the keyword result otherwise. That is a separate PR with its own capability, so turning the shadow on can never start writing categories.

### Point 9: Shadow — `classifyTask`

`apps/web/src/lib/task-category-decision.ts`:

- **Where it runs.** `POST /api/tasks` calls `scheduleTaskCategoryShadow(…, after)` only when the category came from the keyword classifier, not from the caller, and only for a newly filed task, not an `attached` intake. The run happens after the response is sent.
- **It cannot change the task.** The stored `category` is always `classifyTask`'s result, and the shadow run holds no handle to the row.
- **It cannot fail or slow task creation.** Scheduling is wrapped in `try`, the run never throws, and it has a 3-second deadline. The decision client is imported lazily, so the route's static import graph is unchanged.
- **It stays silent by default.** `capability_disabled` and `missing_key` produce no log line.
- **The question.** `TASK_CATEGORY_QUESTIONS` covers all ten stored categories, including `review`, which the regex cannot produce. `research` was added after a research task ("Research … providers") landed on `review` at low confidence: with no research label, the nearest one absorbed it. `review` is now scoped to an existing PR or change, so the two do not overlap. It has contrastive definitions, no catch-all, and an instruction to follow definitions over title keywords. The state is `{ task: { title, description } }`, with the description truncated to 1,500 characters.
- **Privacy.** A workspace with `gitConfig.dataClass === 'sensitive'` is skipped before any call, so its task text never leaves the platform.
- **Telemetry.** One `[decision-shadow] {json}` log line per task, the same observe-only pattern the worker lease used (`[lease-shadow]` in `apps/web/src/lib/stale-workers.ts`).
  - Fields: `taskId`, `workspaceId`, `keyword`, `decision`, `confidence`, `agree`, `probabilities`, `model`, `latencyMs`, `inputTokens` and `costUsd`. `agree` is `null` when the regex abstained.
  - Ids, labels and numbers only. The task's title and description are never logged.
  - The table-free choice is deliberate. Agreement with a regex is not accuracy; it only shows where to look. The real measurement is the benchmark on hand-labelled data, which needs task ids (to join and label locally), not another table. If a shadow ever needs durable, queryable storage, `gate_events` is the wrong shape for it, and the right answer is a small events table following `.claude/skills/schema-change/SKILL.md`.
- **Cost of the flag itself.** With the capability off, every auto-classified task creation costs one indexed `teams` lookup after the response. It never costs a network call.

## Open questions

1. **Key precedence: account-first or workspace-first?** I lean account-first, as built. The person whose account filed the work and who brought a key expects that key to be spent. This differs from the runner-credential order in `docs/credentials-architecture.md`, and the two may be worth unifying later. Nothing breaks if the order is flipped: a flip only changes which key is spent.
2. **Should the shadow write somewhere queryable instead of the log?** I lean no until step 5 shows the log is insufficient. Log retention limits how long a shadow window can be, and that is the trade.
3. **A platform-provided OpenRouter key?** Deferred, as for inference calls. It is a pricing decision. Mechanically it would be a new bottom fallback in `resolveDecisionKey`, with no caller change.
4. **`inferenceCall`'s production env fallback.** *Resolved.* The shared `resolveInferenceKey` applies the same production guard to every caller, with `BUILDD_ALLOW_ENV_INFERENCE_KEYS=1` as the opt-in for deployments that relied on an env key (Point 4).
5. **Should decision capabilities live in the inference allowlist or a separate one?** I lean toward the same allowlist, as built. It is one settings surface for "what may buildd spend API money on", and the descriptor's `fallback` field already communicates the difference.

## Non-goals

- **Changing any stored value.** The shadow is observe-only. Applying a decision is step 6, in a separate PR with its own capability.
- **A new credential table**, or a per-integration key store.
- **Adding decision models to the model tier registry** (Point 5).
- **Replacing deterministic rules.** Mission health, merge policy and auto-merge safety stay code. A decision call may add an *escalating* signal and never a relaxing one.
- **Generation, extraction of free values, maths or date logic** through a decision model.
- **Committing labelled data.** The benchmark reads a local, gitignored file. This repo is public.

## Implementation status

Landed:

- `packages/core/decision-client.ts` and its unit tests.
- `packages/core/decision-benchmark.ts` and `scripts/decision-benchmark.ts`.
- The `task_category_shadow` capability.
- The `decision_key` secret purpose.
- The `classifyTask` shadow in `POST /api/tasks`, including the `research` label (PR #2830).
- The key lookup moved onto the shared `resolveInferenceKey` (agent chat P1, PR #2832); `resolveDecisionKey` is now a wrapper.

Landed in PRs #2823 (client, benchmark and shadow) and #2829 (SDK transport, lazy DB import).

Remaining: steps 5 and 6. Both are gated on real shadow and benchmark data, so this doc stays `partially` until one site applies a decision.
