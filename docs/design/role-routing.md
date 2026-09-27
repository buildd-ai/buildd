# Role Routing: Filling a Blank `roleSlug` with a Decision Call

**Status:** Proposed
**Related:** `docs/design/decision-calls.md` (the primitive, the crux and the rollout this follows), `docs/design/model-tiers.md`, `docs/specs/model-routing-and-tiers.md`, `docs/design/roles-scoping.md`, `docs/design/connector-availability-degraded-mode.md`, `docs/design/chat-roles.md`, `packages/core/decision-client.ts` (`decisionCall`, `gateChoice`), `packages/core/inference-policy.ts`, `packages/core/decision-benchmark.ts`, `scripts/decision-benchmark.ts`, `apps/web/src/lib/task-category-decision.ts` (the shadow to copy), `apps/web/src/lib/chat/routing.ts` (`workspaceQuestion`, a dynamic `ChoiceQuestion<string>`), `apps/web/src/app/api/tasks/route.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/workers/claim/role-gate.ts`, `apps/web/src/app/api/workers/claim/connector-gate.ts`, `apps/web/src/lib/required-connectors.ts`, `packages/core/model-router.ts`, `packages/core/task-routing-preview.ts`, `apps/web/src/lib/default-roles.ts`, `apps/runner/src/role-advertising.ts`, `apps/web/src/app/app/(protected)/home/FleetStrip.tsx`

---

## Problem

Most tasks are filed with `roleSlug = null`. Over a recent 30-day window, `get_usage_stats groupBy=role` for buildd's own workspace shows `(unassigned)` as the largest bucket, larger than every named role combined. `docs/SPEC.md` and `docs/design/unified-app-ia.md` both describe a null role as "the normal case", and nothing tries to change that.

A role-less task:

- gets no role persona (`content`), no `allowedTools` restriction, no role `connectorRefs`, and no role model floor;
- shows a grey `?` in the Home fleet strip (`RoleSquare`, `home/FleetStrip.tsx:33`, rendered at `:113` from `w.roleName ?? w.roleSlug`);
- counts as `(unassigned)` in every role histogram, so per-role cost and success numbers describe only the minority of work that happened to be labelled.

The same gap makes narrow roles not worth creating. A role is only used when whoever files the task remembers that it exists and types its slug. A workspace that defines a "Migrations" or "Docs" specialist gets no traffic for it unless every filer, human or agent, changes habits.

`docs/design/decision-calls.md` Point 8 already ranks role routing fourth among candidate sites: "Fit as a **suggestion only** … fill it when the caller left it empty and confidence is high. Labels are per workspace, so criteria come from role descriptions at call time." This doc is that design.

Two things make it harder than the category shadow:

1. **A wrong answer can strand a task.** The claim filter (`roleSlugGate`, `claim/role-gate.ts`) only admits a task whose slug the runner can serve. A slug no online runner can claim leaves the task pending forever. The team's knowledge base holds this as a gotcha against inferring roles from `kind` or a title.
2. **A role is not only a persona.** It carries `model` (a floor, or an exact pin), `defaultBackend`, `allowedTools` and `connectorRefs`, and several of those change the model, the cost or the claimability of a task. Filling in a role by inference would silently change all of them unless this design says otherwise.

## Current state

### How a role reaches a task today

- `POST /api/tasks` stores `roleSlug` only when the caller sends it (`apps/web/src/app/api/tasks/route.ts:1207`). Nothing infers it.
- The role's `defaultBackend` is resolved **at creation** (`tasks/route.ts:965-990`, `:1078-1086`: task → mission → role → workspace → `claude`).
- `requiredConnectors` requires a stated `roleSlug` and must be a subset of that role's `connectorRefs` (`validateRequiredConnectors`, `apps/web/src/lib/required-connectors.ts:54`). **So a task that declares a connector requirement is never role-less, and never reaches inference.**
- The role's `model` is resolved **at claim** (`claim/route.ts:806-839` builds `roleFloorMap`; `:1533-1561` feeds it to `resolveEffectiveModel`).

### Claimability (`role-gate.ts`)

The note in the brief (`roleSlug IS NULL OR roleSlug IN availableSkills`) describes the older rule. The current rule, `roleSlugGate` / `isRoleClaimable`, has two parts:

1. **Explicit slugs** (`EXPLICIT_ROLE_SLUGS`, `packages/shared/src/types.ts:1684`, today only `visual-auditor`) are claimable only by a runner that lists that slug in `availableSkills`.
2. **Every other slug** is claimable by a runner that advertises **no** legacy slugs, or one whose legacy list includes it.

The buildd runner advertises only `visual-auditor`, and only when a browser launches (`advertisedRoleSlugs`, `apps/runner/src/role-advertising.ts`). Its legacy list is therefore always empty, so a buildd runner can claim any non-explicit role. The server does **not** persist `availableSkills`: it arrives in the claim body (`claim/route.ts:135`) and is gone after the request. `worker_heartbeats` stores `workspaceIds` and `environment`, but not the advertised slugs.

That constraint shapes §3 below: a candidate set cannot be computed exactly from stored state, but it can be computed conservatively.

### Model precedence at claim (`claim/route.ts:1533-1599`, `model-router.ts:90-169`)

In order, first match wins:

1. The caller's pin (`readModelPin(context)`).
2. **A role `model` that is not a tier alias** (i.e. an exact model id). It is passed as `explicitModel` (`:1554`) and short-circuits everything, **including an explicit `tasks.tier`**, because the `tier` lookup only runs on the non-explicit branch (`:1585-1590`).
3. `tasks.tier`, which discards the router's tier *and* the role floor (`:1590`).
4. `kind × complexity` baseline, budget/spike downshift, then the **role floor clamp** (`model-router.ts:155-161`). The floor is never a cap. `premium-plus` and `premium` both clamp to `opus` (`:1548`), and `mapRouterAlias('opus')` gives back `premium`. **So a role set to `premium-plus` gets `premium`**, unless the task itself says `tier: "premium-plus"`.

The creation-time preview (`computeRoutingPreview`, `packages/core/task-routing-preview.ts:185`) **does not look at the role at all**. Its input has no `roleSlug`. Today the preview is already wrong for any task whose stated role has a floor above the matrix or an exact pin.

### Decision-call policy

Since `c711c4c85`/#2883, `packages/core/inference-policy.ts` has no per-team allowlist for decision calls. A `built_in` capability "runs whenever a key resolves" (`isInferenceAllowed`, `:132-138`). The header of `task-category-decision.ts` still says the team "must enable the `task_category_shadow` inference capability". That comment is stale, which matters here because §6(a) asks for a capability that is off by default. Adding it as a plain `built_in` would switch it on for every team that has a key.

The `task_classification` capability ("Tags a new task with its kind and complexity") has a descriptor and no call site. The #2616 kind/complexity inference is the deterministic `inferRouting` (`task-routing-preview.ts:128`), not a decision call.

## Proposal

### The crux

**An inferred role changes *who does the work*: the persona prompt, the tool allowlist and the mounted connectors. It never changes *what the work runs on* (model, tier, backend), and never *whether the work can be claimed*.**

Everything below follows from this:

- The inferred role's `model` is not applied (§4), so the creation-time preview stays true and two stacked inferences cannot move the model.
- The candidate set is filtered to roles every eligible runner can claim, whose connectors are healthy and whose backend matches the task (§3), so the model cannot pick a role that strands the task.
- A role is a candidate only if it describes itself (§2), so the model is choosing among definitions a human wrote for this purpose, not guessing from a slug.

**What breaks if the crux is wrong.** Suppose the inferred role were allowed to carry its model. Seeded `builder` has `model: 'opus'` (`default-roles.ts:275`). Every role-less engineering task that routing sent to Builder would then jump from `standard` to `premium` and become immune to budget downshifts (`model-router.ts:155`: a floor defeats every downshift the budget and spike gates applied). That is the largest cost change buildd could make by accident, made by a classifier, and invisible in the preview. The crux rules it out by construction rather than by a threshold.

### 1. Remaining role-less creation sites

*(Deterministic fixes do not go through the model. Each "yes" below is its own builder task.)*

**How big each bucket is.** `get_usage_stats groupBy=role` splits by role only. It cannot split `(unassigned)` by creation site. `list_tasks` in audit mode now works, but it returns neither `roleSlug` nor `creationSource`, and worker sandboxes have no DB access by design. So the sizes below are qualitative. They come from the site's call rate, and from a prior attribution of the bucket held in the team's knowledge base.

Making them exact is the first part of §6(d): `get_usage_stats` gains a `groupBy=creationSource` view, and `(unassigned)` gets a breakdown by `creationSource × taskClass`.

Out of scope, as the brief says: the attempt sites fixed by `lib/attempt-identity.ts` (`inheritAttemptIdentity`: CI retry, conflict retry, reviewer request-changes retry) and the `stale-workers.ts` / `answer-resume.ts` continuations. All of them now inherit the parent's role.

| # | Site | Where it inserts | Role today | Deterministic role? | Size |
|---|---|---|---|---|---|
| 1 | **MCP / API `create_task`**, including agent-filed follow-ups | `packages/core/mcp-tools.ts:2283` → `POST /api/tasks`, insert `apps/web/src/app/api/tasks/route.ts:1157`, `roleSlug` only if sent (`:1207`) | caller's, else null | **Partly.** When the creator is a worker, `resolveCreatorContext` (`tasks/route.ts:746-753`, `lib/task-service.ts:36-62`) already resolves its `parentTaskId` and the MCP path fetches the caller's worker (`mcp-tools.ts:2433`) — but only `missionId` is inherited (`:2434`). Inheriting the *creator's* role is wrong (an Organizer files Builder work; a Builder files Researcher follow-ups), so no. **Model territory.** | Largest bucket |
| 2 | **Chat `create_task`** | `apps/web/src/lib/chat/tools.ts:128-143` → MCP handler; `in-process-api.ts:276` forces `creationSource: 'dashboard'` | optional, null in practice | **No.** Chat has no role of its own (`chat-roles.md`). **Model territory.** Note it is indistinguishable from a dashboard task by `creationSource`; §6(d)'s breakdown needs a marker (`context.via: 'chat'`) to size it. | Growing |
| 3 | **Human quick-add on a mission** | `missions/[id]/MissionSettings.tsx:215-219` posts `{ title, workspaceId, missionId }` | null | **No** as a default, but the component already receives `roles` (`:30`, `:52`) and does not render a picker. **Yes as UI:** add the role picker the new-task page has (`tasks/new/page.tsx:952-970`, "Any role" default), and pre-fill it from the shadow's suggestion once (c) exists. | Small–medium |
| 4 | **New-task page** | `tasks/new/page.tsx:404-423` | picker, default "Any role" | Already a picker. **Model territory** when left on "Any role". | Medium |
| 5 | **Friction tasks** | agent-filed via `create_task` (dedupe `tasks/route.ts:592-646`); server-side at `api/cron/mission-invariants/route.ts:156` and `lib/schedule-skill-preflight.ts:172` | null | **No single role.** A friction report is a bug report about the platform; the fix may be Builder work or a Researcher diagnosis. Leave to the model — and friction titles start with `[friction]`, which makes them an easy, well-separated benchmark slice. | Medium |
| 6 | **`approve_plan` children** | `apps/web/src/lib/approve-plan.ts:275-276`, `roleSlug: step.roleSlug \|\| null` (`:290`) | from the plan step | **Yes, partly, deterministically:** the planner prompt already asks for `roleSlug` (`default-roles.ts:89`, `:109`) but `planning.ts` leaves it optional (`:39`, `:138`, required fields `:182`). Two fixes, one builder task: validate a present `step.roleSlug` against the workspace's roles at approve time, because an unknown slug strands the child (§3.2). A missing step role stays null and goes to the model. Do not inherit the planning task's own role, which is the Organizer. | Medium |
| 7 | **Bot / foreign PR adoption** (`request_pr_review`, webhook, retry-CI) | `apps/web/src/lib/pr-review-request.ts:187-208` (from `api/github/pr/review/route.ts:307`, `github/webhook/route.ts:1563`, `api/prs/[prNumber]/retry-ci/route.ts:117`) | null | **No role — it is not work.** The adopted row is inserted `status: 'completed'`, is never claimed and runs no worker; it exists to own the PR. The review itself is `createReviewerTask` (`reviewer.ts:558-565`) with `pickReviewerRole` (`pr-review-status.ts:274-298`: requested → `mergePolicy.agentReview.reviewerRole` → `reviewer`/`spec-validator`/`builder` → first role), which already carries a role. Giving the adopted row `reviewerRole` would mislabel a placeholder as review work. **Deterministic fix instead:** stamp it `taskClass: 'bookkeeping'` so role-centric views and the `(unassigned)` count skip it. Open PR #2908 stops adopting Renovate/Dependabot PRs altogether, which removes the bot share of this bucket. | Small (no workers) |
| 8 | **Residual attempt sites the identity fix did not reach** | `lib/dead-zone-sweep.ts:381` (conflict retry, hand-enumerated columns, no role — unlike `conflict-retry.ts`); `api/prs/[prNumber]/retry-ci/route.ts:151` (diagnose) and `:230` (manual CI retry); `api/github/webhook/route.ts:1645` (schema-drift diagnose); `api/prs/[prNumber]/apply-recommendation/route.ts:156`; `api/tasks/[id]/reject-plan/route.ts:120` (revised plan) | null | **Yes — inherit via `inheritAttemptIdentity` / the parent's `roleSlug`**, all in one builder task. These are the same gotcha the attempt-identity fix addressed, at sites it did not touch. | Small, but each is a *known* role lost |
| 9 | **Mission/orchestration bookkeeping** | `lib/mission-criteria-verify.ts:258`, `mission-criteria-worker-eval.ts:289`, `mission-criteria-prose.ts:370`, `mission-evaluation.ts:207`, `mission-pr.ts:564`, `task-dependencies.ts:434` (aggregate), `doc-fix-dispatch.ts:257`, `experiment-cleanup-task.ts:79`, `release-health-watcher.ts:97` | null | **Per site, deterministically — never the model.** Each pipeline knows what it is dispatching (a verification run is read-only; a doc fix is Writer/Builder; a release-health task is the watched project's `ops`-style role, as `health-watcher.ts:238` already does). One builder task to assign each a constant or pass-through role, *only* where the target role exists in the workspace (§3.1), else null. | Small–medium |
| 10 | **External intake** | `api/github/webhook/route.ts:306` (issue → task), `api/webhooks/ingest/route.ts:132`, `lib/linear-webhook.ts:180` | null | **No.** Free text from outside. **Model territory.** | Small |
| 11 | **Scheduled tasks** | `api/cron/schedules/route.ts:816`; the template has no `roleSlug` (`schema.ts:566-580`) | null | **Yes, as a field:** add `roleSlug` to `TaskScheduleTemplate` so a schedule states its role once. Until then, model territory. | Small |

Already set, for completeness: heartbeats (`mission-run.ts:642`), surface audit (`mission-surface-audit.ts:152`, `:265`), reviewer runs (`reviewer.ts:565`), watched-project health tasks (`health-watcher.ts:238`, `:448`).

**What is left for the model** is rows 1, 2, 4, 5, 10, and 3/6/11 until their deterministic pieces land. That is free-text work filed by a human or an agent that did not name a role. It is exactly the population the decision call is for. Everything else gets fixed in code first, so the benchmark (§6(b)) is not polluted by pipeline rows that code can already label.

### 2. Role frontmatter: `whenToUse` and `notFor`

Two new optional fields on a role. They are the Choice criteria text, so **they are the prompt**. The model reads nothing else about the role: not `content`, not `description`, not the slug.

| Field | Required for routing | Limit | Shape |
|---|---|---|---|
| `whenToUse` | yes | 20–300 characters | One or two sentences: the kind of work this role should pick up, in the filer's vocabulary ("Code changes that end in a PR: features, bug fixes, refactors, migrations"). |
| `notFor` | no | ≤ 200 characters | The nearest work that belongs to another role, named ("Investigating without changing code (Researcher); reviewing an existing PR (Reviewer)"). |

**Why these limits.** `decision-calls.md` Point 7 rule 1: "Definitions matter more than the model." Jev accuracy falls as irrelevant state grows. At 255 labels maximum (`MAX_CHOICE_OPTIONS`), 500 characters per role × a typical five to ten candidates stays a few hundred tokens, the same order as the category question. The 20-character minimum rejects a placeholder such as "builder" that would make the label as uninformative as the slug.

**Rendered criterion.** One string per label, the same shape as `TASK_CATEGORY_QUESTIONS`' `{what, not_for}`, flattened because `workspaceQuestion` uses flat strings:

```
<whenToUse> Not for: <notFor>.
```

**Storage: `workspaceSkills.metadata.routing`, no migration.** `metadata` is already `jsonb` (`schema.ts:2280`) and already round-trips through `register_skill` / `update_skill` / `POST /api/workspaces/[id]/skills` (`route.ts:140`, `:194`, `:248`):

```ts
metadata.routing = { whenToUse: string; notFor?: string; updatedAt: string }
```

`register_skill` / `update_skill` gain `whenToUse` and `notFor` params that write this key, validated to the limits above (400 on violation, never truncated silently). A SKILL.md with a `when_to_use:` frontmatter line (the Claude Code skill convention) is copied into `metadata.routing.whenToUse` by the same path, so a role written as a file opts in the same way. Nothing parses role `content` today, and this does not start doing so beyond that one key.

**Field-level overrides.** Roles are team-level with per-workspace override rows (#1004, `docs/design/roles-scoping.md`; `schema.ts:2307-2310`). `routing` follows the same rule as the other fields: the workspace override's `metadata.routing` if present, else the team default's. An override can therefore describe a role differently for one repo, or opt it out with `routing: { disabled: true }`.

**Seeded defaults.** `DefaultRole` (`default-roles.ts:28`) gains `whenToUse` / `notFor`, and `seedDefaultRolesForTeam` (`:689`) writes them into `metadata.routing`. Seeding is `onConflictDoNothing`, so **existing teams never pick up a change to `default-roles.ts`**. The team's knowledge base records the same trap for heartbeat instructions keyed on role content. Existing rows need a one-off, idempotent backfill script: set `metadata.routing` only where `source = 'system'`, the slug is a default, and `metadata.routing` is absent. It must never overwrite a row that already has routing text, and it has to be run deliberately, not on deploy. The seeded text is the `routing` field on each `DEFAULT_ROLES` entry. The live team's text, including the reasons each excluded role is excluded and why `spec-validator` is routable after all, is in `docs/design/role-routing-text.md`. `reviewer` and `visual-auditor` are seeded with `routing: { disabled: true }`, not simply left without text, so the exclusion is deliberate and survives someone adding text later.

**A role with no `whenToUse` is excluded from the candidate set.** It is not guessed from `description`. `description` is written for the Team page ("Core engineering — features, bug fixes, refactoring, releases") and is not contrastive. Using it would reintroduce the overlapping-label problem `decision-calls.md` Point 7 rule 3 warns about. **Opting in is writing the sentence.** A workspace-defined specialist becomes reachable the moment someone describes it, and a role nobody describes stays exactly as reachable as today.

### 3. Candidate set

Computed per task, at decision time, in code. The model never sees a role that fails any filter. The label set is:

> **candidates** = roles effective for the task's workspace (§3.1)
> ∩ enabled, `isRole`, has `routing.whenToUse`, not `routing.disabled` (§2)
> ∖ explicit slugs (§3.2)
> ∖ roles whose connectors are unusable (§3.3)
> ∖ roles whose tools cannot produce the task's required output (§3.4)
> ∖ roles whose `defaultBackend` differs from the task's resolved backend (§3.5)

plus **no `none` label** (see below). With fewer than two candidates the call is not made, because there is nothing to choose between. `workspaceQuestion` applies the same rule.

**No `none` label.** The brief asks for one, but `decision-calls.md` Point 7 rule 2 says "No catch-all label … 'Nothing fits' should show up as low confidence, and the gate handles it". The workspace question in `chat/routing.ts` follows that rule. A `none` label defined as "none of the above" is a catch-all, and it would absorb exactly the unfamiliar tasks whose low confidence is the signal. The outcome the brief wants from `none` (the role stays null) is what a below-threshold answer already produces. This is Open decision 3.

#### 3.1 Scoping: resolve like `checkConnectorRouting`, not like `roleFloorMap`

Roles are team-level with workspace overrides. The per-task resolution the claim path uses for connectors is `checkConnectorRouting` (`connector-gate.ts:51-72`): `teamId = task's team AND (workspaceId IS NULL OR workspaceId = task's workspace)`, workspace row wins. The candidate query uses exactly that, keyed by `(slug)` within the task's workspace.

The claim route's `roleFloorMap` (`claim/route.ts:806-839`) resolves differently. It matches override rows for **all of the runner's** `workspaceIds` plus legacy account-level rows, and keys the map by slug alone. Two workspaces that override the same slug with different models can therefore swap floors. That is a pre-existing bug, independent of this design. It belongs in the builder task for §4, because the fix is the same resolution.

#### 3.2 Claimability

The server cannot see every runner's `availableSkills` (not persisted, §Current state). So the filter is conservative rather than exact:

- **Exclude every `EXPLICIT_ROLE_SLUGS` entry.** These are the only slugs that need a runner to opt in. They are also created by pipelines that set them already (`visual-auditor`).
- **Allow non-explicit slugs.** A runner with an empty legacy list claims any of them. That is every buildd runner today (`role-advertising.ts`), and the claim-latency metric (§6(d)) catches a deployment where that stops being true.

The stronger version, persisting `availableSkills` onto `worker_heartbeats` and intersecting with online runners that serve the workspace, is Open decision 4. It is not needed while the only runners that restrict legacy slugs are hypothetical.

#### 3.3 Connectors and MCP

- **A task with `requiredConnectors` never reaches inference**, because it already has a stated role (§Current state).
- **A role whose `connectorRefs` include a connector that is `never_mounted` or `expired_or_revoked` for the task's workspace is excluded.** Use the same classification `checkConnectorRouting` produces, **without** the HTTP probe (`transient`). The probe costs up to 5 s, and a transient failure is not a reason to route away permanently. `list_connectors`' `auth_expired`/`disabled` are the user-facing names for those two modes. Without this filter, routing sends work to a role the claim pre-filter (`runConnectorPreFilter`, `claim/route.ts:662`) then refuses or degrades, which is strictly worse than no role.
- **The legacy `mcpServers`/`requiredEnvVars` fields** (deprecated, `schema.ts:2292-2296`) are not checked. A role that still depends on them and has a missing secret fails the same way with or without routing, and connectors are the supported path.
- **Should a connector need constrain candidates up front?** Only through `requiredConnectors`, which already requires a stated role. Inferring "this task needs the Linear connector" from its text is a second classification with its own error rate. It is out of scope here.

#### 3.4 Tool abilities

A read-only role must not win a task that has to open a PR. Filter in code, before the call:

- **`outputRequirement = 'pr_required'`** (stated, or resolved from `auto`): exclude a role whose non-empty `allowedTools` lacks **both** `Edit`/`Write` and `Bash`. Empty `allowedTools` means "all tools" (`schema.ts:2287`) and passes.
- **Concrete `pathManifest`** (not the advisory `**`): same rule. A manifest names files to change.
- **`outputRequirement = 'artifact_required' | 'none'`**: no tool filter. A builder can also write an artifact.
- **`emitsPlan: true`** is already `mode: 'planning'`, and its output is a plan, so no tool filter applies.

These are exact structural facts. Leaving them to the model would spend its accuracy on something code already knows (`decision-calls.md` Point 7: "Use code for … anything already computable from structured fields").

#### 3.5 Backend

`defaultBackend` is resolved at creation (§Current state). The decision runs after creation, so it cannot change the backend without re-resolving it, and the crux says it must not. **Exclude a role whose `defaultBackend` is set and differs from the task's stored `backend`.** Otherwise a Codex-defaulted specialist would win a task that is already queued for Claude runners, and the prompt it gets would be written for the other engine.

### 4. Model conflicts, settled before anything applies

#### 4.1 Precedence

| Source | Stated by caller | Inferred |
|---|---|---|
| `context.model` pin | wins over everything (unchanged) | n/a |
| `tasks.tier` | wins over everything below (unchanged) | n/a |
| role `model` = exact id | wins over matrix. **Should lose to a stated `tier`** (fix below). | **ignored** |
| role `model` = tier / legacy alias | a **floor** over the matrix (unchanged) | **ignored** |
| `kind × complexity` | matrix | #2616 heuristic, then the matrix |

**An inferred role's `model` is treated as `inherit`.** It is neither a floor, nor a ceiling, nor an override. That is the crux applied to the model. The claim route reads `context.roleInferred` (§6(c)) and, when it is present, sets `roleModel = null` before `routerRoleFloor` / `roleIsFullId` are computed (`claim/route.ts:1538`). Everything else about the claim-time chain is unchanged.

The reasons, in order:

1. **"Explicit caller value always wins over inferred" is not enough on its own.** Most role-less tasks have **no** explicit tier or model, so an inferred role floor would win by default. That is precisely the `standard → premium` jump in §The crux.
2. **It makes stacking impossible.** Only the #2616 kind/complexity inference can move the model, and it already reports in the preview. An inferred role plus an inferred kind cannot combine into premium-plus or budget, because the role contributes nothing to the model.
3. **It keeps the preview true.** The decision runs after the response is sent (§5), so the `routing` preview in the `create_task` response is computed before any role is inferred. If the inferred role could change the model, that preview would be stale on arrival.

**If the role's model should matter.** Say the team wants routed Builder work at premium. The fix is to state it: set the tier on the task, or accept the inferred role by editing the task, which makes it stated. This is Open decision 1. A role floor that applies only once the role has been confirmed is the natural later step.

#### 4.2 The `create_task` routing preview

Two changes, both independent of inference and both needed first:

1. **Preview the stated role.** `RoutingPreviewInput` gains `roleModel`, resolved like §3.1. When a stated role's floor raises the tier or its exact id pins the model, `reason` names it: `role "builder" floor premium raised standard → premium (Opus)`, or `role "x" pins claude-… — bypasses tier routing`. Today the preview ignores the role entirely (§Current state), so for a stated role it can already disagree with the claim.
2. **Say what inference may do.** When `roleSlug` is blank and the workspace has at least two candidates, append: `no role given — one may be inferred after creation; an inferred role does not change the model`. With §4.1 in place that sentence is true, and it tells filers that stating a role is how they get its floor.

When the apply step (§6(c)) writes a role, it also writes `context.routingReason` so the task page's model cell (`TaskModelCell.tsx`, #2616) shows `role "builder" inferred (0.93) — model unchanged`.

#### 4.3 Fix the exact-id-beats-tier inversion

Today a role pinned to an exact model id outranks an explicit `tasks.tier` (`claim/route.ts:1554`, `:1585`). The spec (`docs/specs/model-routing-and-tiers.md`, "Claim-time model resolution") records this as the intended order. It contradicts "an explicit caller value must always win", and it matters more once more tasks carry roles. Proposed order: `context.model` → `tasks.tier` → role exact id → matrix + role floor. This is a model-routing change with its own spec update and its own builder task, and it must land before §6(c).

**Landed** (with §4.1's inferred-role guard, §4.2's preview and §3.1's `roleFloorMap` scoping): `packages/core/role-model-routing.ts` holds the shared precedence; the spec section above now records the new order.

#### 4.4 Audit: role `model` values that conflict with the tier registry

Registry today (`manage_model_tiers list`): all four tiers resolve to catalog or team rows. No workspace overrides.

| Where | Role | `model` | Conflict |
|---|---|---|---|
| Seed (`default-roles.ts:275`) | `builder` | `opus` | Legacy shorthand. A **premium floor on every Builder task**, and it defeats budget downshifts. New teams get it. Buildd's own row has since been set to `inherit`, which is why it does not show up there. |
| Seed (`:173`, `:322`, `:359`, `:396`, `:465`, `:594`, `:669`) | `organizer`, `researcher`, `writer`, `analyst`, `reviewer`, `visual-auditor`, `spec-validator` | `sonnet` | Legacy shorthand. A standard floor, so it lifts `simple` (haiku) work and cancels budget downshifts to budget tier. It is harmless as a floor, but it is the old vocabulary, and `mapRouterAlias` maps any unknown string to `standard` too. |
| Existing rows, this team | several | `sonnet` | Same as above: seeded before tier vocabulary. |
| Existing rows, this team | one team-level custom role | an exact `claude-…` id | **Bypasses the registry** and, until §4.3, outranks an explicit `tasks.tier`. A registry change never reaches it. |
| Existing rows, this team | `visual-auditor` override | `standard` | Tier vocabulary. No conflict. |
| Any row | — | `premium-plus` | None today. It used to silently become `premium` (`claim/route.ts:1548` → `mapRouterAlias`). **Fixed** in §4.3's task: a `premium-plus` role floor now resolves to the `premium-plus` tier (`roleTierOverride`). |

The per-row detail for this team is in the task's analysis artifact, not here (this repo is public). Recommendation, as its own task and not a precondition for the shadow: migrate seeded `sonnet`/`opus` to `standard`/`premium` (no behaviour change, since they map 1:1), and reconsider whether seeded Builder should floor at `premium` at all. That is a cost decision, so it is Open decision 6.

#### 4.5 Should the same call answer `kind`?

**Yes, in the same request, shadow only, and only when `kind` is blank.** Questions in one request are evaluated in parallel against the same state (`decision-calls.md`, intent routing), so a second question costs almost nothing. `kind` is also what `create_task` most often lacks: the tool text says it is required, and it still arrives blank.

- The label set is `TaskKind` (`model-router.ts:16-23`), seven labels with contrastive definitions written the way `CATEGORY_CRITERIA` is.
- **The #2616 heuristic stays the incumbent.** Its two kind rules (`emitsPlan`, coordination title prefixes, `task-routing-preview.ts:85-98`) are exact and stay in code. When the heuristic fires, the decision `kind` is logged for agreement only. When it does not, the decision `kind` is the only candidate.
- **Applying an inferred `kind` is a model change**, because it feeds the matrix. It is gated separately from the role, with its own threshold and its own capability, and it is out of scope for §6(c). It would write `classifiedBy: 'classifier'` and `context.routingInferred`, exactly the #2616 markers, so analytics already separate it.
- `complexity` is **not** asked. `decision-calls.md` Point 8 rank 2 notes complexity as the better fit of the two, but it is the axis that moves cost. It deserves its own shadow, so a regression can be told apart from this one.

### 5. The decision call

**When it runs.** In `POST /api/tasks`, next to `scheduleTaskCategoryShadow` (`tasks/route.ts:1323-1339`), scheduled with `after()`, and only when all of these hold:

- the caller sent no `roleSlug`;
- `intake.outcome.action !== 'attached'`;
- `taskClass` is `work`, since bookkeeping/attempt rows get their role from their parent or pipeline;
- the workspace is not `gitConfig.dataClass === 'sensitive'`;
- the candidate set (§3) has at least two roles.

The candidate query runs inside the `after()` callback, never on the request path. It cannot delay or fail `create_task`: the scheduling is wrapped in `try`, the run never throws, and the decision client is imported lazily (the pattern in `task-category-decision.ts:151-224`).

**Question shape.** The role question is a dynamic `ChoiceQuestion<string>` built like `workspaceQuestion` (`chat/routing.ts:111`):

```ts
role: {
  type: 'choice',
  instructions: {
    question: 'Which role should do the work described in `task`?',
    rule: 'Follow the role definitions. The task title often names an action ("fix", "review", "document") that a definition assigns to a different role; the definition wins.',
  },
  criteria: { [label]: `${whenToUse}${notFor ? ` Not for: ${notFor}.` : ''}` },
}
```

- **Labels are role names, not slugs**, because the model reads them. A name shared by two candidates gets its slug appended, and `idFor: Map<label, slug>` maps back, exactly as `workspaceQuestion` does with short ids.
- **The label order is sorted** by slug, so the same candidate set always produces the same request. That keeps benchmark rows comparable.
- `kind` (§4.5) is asked in the same request when blank.

**State (the only task fields sent).** This is `buildTaskRoleState`:

```ts
{ task: {
    title,                       // trimmed
    label,                       // the chip noun-phrase, if any
    kind,                        // stated kind or null
    description,                 // truncated to 1,500 chars (SHADOW_DESCRIPTION_CHARS)
    paths,                       // pathManifest, at most 20 entries, null for the advisory "**"
    source,                      // creationSource
    inMission,                   // boolean — never the mission's id or title
    output,                      // outputRequirement after resolution
} }
```

Never sent: `context` (it can hold PR bodies, failure logs, prior summaries), the mission's text, dependencies, or anything about the filer.

**Timeout.** 3 s whole-call (`SHADOW_TIMEOUT_MS`), with the client's single transient retry. That is the shadow's budget. The apply step (§6(c)) keeps it, because it also runs after the response.

**The race with claiming.** A decision that returns after the task was claimed is useless for apply. `dispatchNewTask` (`tasks/route.ts:1313`) can hand the task to an idle runner within the same second. The shadow measures this, and does not guess. Each record carries `claimedBeforeDecision: boolean`, read with one indexed lookup of `tasks.claimedAt` after the call returns. If that rate is high, apply needs a short claim hold for role-less tasks with ≥ 2 candidates. That is Open decision 5, and it is decided on data from (a).

**Cost.** One call per role-less task. State plus criteria are a few hundred to about a thousand input tokens, and output is free. That is the same order as the category shadow, which `inference-policy.ts` prices at roughly $0.00002 per task.

### 6. Rollout, following `decision-calls.md`'s crux

The role decision is only ever an accelerator in front of today's logic, and today's logic is "leave `roleSlug` null". Every failure and every low-confidence answer lands there.

#### (a) Shadow: `task_role_shadow`, off by default

- **The capability** is `task_role_shadow`, added to `InferenceCapability`. **Off by default needs a new mechanism**, because `built_in` means "on whenever a key resolves" since #2883 (§Current state). The proposal is a fourth kind, `opt_in`, allowed only when the team row lists it in a new `teams.enabledDecisionShadows` text array. The column is nullable with no default, so merging is a no-op (DESIGN-FORMAT rule 2). The alternative is an env allowlist. Open decision 2.
- **The module** is `apps/web/src/lib/task-role-decision.ts`, a copy of `task-category-decision.ts`: `runTaskRoleShadow`, `scheduleTaskRoleShadow`, and a `deps.decide` injection point for tests.
- **Telemetry** is one `[decision-shadow]` line per task with `site: 'task_role'`: `taskId`, `workspaceId`, `candidates` (slugs), `decision` (slug), `confidence`, `probabilities` (slug-keyed), `kindDecision`, `kindConfidence`, `kindHeuristic`, `claimedBeforeDecision`, `model`, `latencyMs`, `inputTokens` and `costUsd`. Ids, slugs and numbers only. No title, no description, and no `whenToUse` text, since a workspace's role descriptions are its own content.
- **Also shadow a sample of tasks that stated a role.** A task whose filer chose a role is a free label. Shadowing about one in five of them (deterministic on `taskId`) gives the benchmark agreement data from real filer choices at no labelling cost. Those rows are marked `stated: '<slug>'` and are never candidates for apply.
- **It never writes.** The run holds no handle to the task row. A unit test asserts that the module imports no DB write path, the same guarantee the category shadow gives.

#### (b) Label, benchmark, pick the threshold

- **Data** goes to `.decision-data/task-role.jsonl` (gitignored). Each row is `{ id, state, label, candidates: [{ slug, name, whenToUse, notFor }] }`. The candidate list is **stored per row**, because the label set is per workspace and changes as roles are described. A benchmark that rebuilt the question from today's roles would score old tasks against labels they never had.
- **Benchmark.** `scripts/decision-benchmark.ts` gains a `task_role` set whose `questions` are built per row from `row.candidates`, instead of the static `SETS[name].questions`. That is a small change to the I/O half; the pure `packages/core/decision-benchmark.ts` scoring is label-agnostic already. The incumbent line is "always null", whose accuracy is the share of rows labelled `none`. So the table to read is **coverage at each threshold**, not accuracy over the incumbent.
- **Labels.** The stated-role sample from (a) goes in as-is. Role-less tasks are hand-labelled, with `none` allowed as a *label* (meaning "no role should take this", e.g. a bookkeeping echo). That is distinct from a `none` *option* in the question. A below-threshold answer on a `none`-labelled row counts as correct.
- **Threshold.** Pick the lowest threshold at which **precision is at least 0.95 on every label with n ≥ 10**, not overall accuracy. A wrong role is worse than no role, and one weak label hides inside a good average. Expect it to land higher than the category threshold.
- **Read the category shadow in the same pass.** Its step 5 has not been done (`decision-calls.md`, Implementation sketch). Both shadows fire on the same `POST /api/tasks` population, and their lines share a `taskId`. **Label both from the same task sample, in one session.** Each hand-labelled task then yields a category *and* a role label. The cost of the second label is seconds once the task is on screen, and it also shows whether the two disagree in a way that points to a definition problem (a task labelled `docs` routed to Builder). The two thresholds are still chosen separately; `decision-calls.md` Point 2 says thresholds do not transfer.

#### (c) Apply behind `gateChoice`, a separate PR and capability

- **The capability** is `task_role_apply`, a separate `opt_in` entry, so turning the shadow on can never start writing roles.
- `applyTaskRoleDecision` runs in the same `after()` callback as the shadow. When `gateChoice(answer, TASK_ROLE_MIN_CONFIDENCE)` returns `apply: true`, it runs one guarded write:
  ```sql
  UPDATE tasks SET role_slug = $slug,
         context = context || '{"roleInferred": {...}}'
  WHERE id = $id AND role_slug IS NULL AND status = 'pending' AND claimed_at IS NULL
  RETURNING id
  ```
  No rows back means the task was claimed or edited first. That is logged as `outcome: 'lost_race'` and nothing else happens. The guard is atomic `UPDATE … WHERE`, with no transaction, per CLAUDE.md's neon-http rule.
- **`context.roleInferred`** is `{ slug, confidence, model, candidates: number, at }`.
- **`classifiedBy` is NOT stamped.** The brief asks for `classifiedBy: 'classifier'`, but that column is the provenance of **kind/complexity**. It is written only from `rawKind`/`rawComplexity`/`routingWasInferred` (`tasks/route.ts:1215-1217`), and copied to `task_outcomes.classifiedBy` for routing calibration (`schema.ts:2326`). Stamping it for a role would tell the calibration cron that a user-stated kind was machine-inferred. `context.roleInferred` is the marker. Open decision 7 covers a dedicated column if analytics need an index.
- **Below threshold, a failure, fewer than two candidates, or `lost_race`** all leave `roleSlug` null. That is today's behaviour, with no retry and no second attempt at claim time.
- **Re-check the candidate still qualifies at write time.** Between the query and the write, a connector can expire or a role can be disabled. The `UPDATE` does not re-validate those. The write path re-reads the one chosen role, with its enabled flag, `routing.whenToUse` and connector modes, immediately before the `UPDATE`, and skips on any change.
- **What changes for the task.** The persona, the `allowedTools`, the connectors, the fleet-strip square, and the role histogram bucket. Model, tier and backend do not change (§4.1, §3.5).
- **Undo.** An inferred role is visible on the task page with its confidence. Editing the role makes it stated, and clearing it sets it back to null. Either way `context.roleInferred` is kept for the audit trail and `roleInferredOverridden: true` is added. Overrides are the fastest real-world error signal, and (d) reports them.

#### (d) Metrics

- **Primary: the `(unassigned)` share** in `get_usage_stats groupBy=role`, over time.
- **Stated and inferred reported separately.** `usage-stats.ts` splits each role group into `stated` and `inferred` (read from `context.roleInferred`), so `Builder` becomes `Builder · stated` / `Builder · inferred`. Without the split, a routing change would move the Builder success rate and nobody could tell whether Builder got worse or routing sent it harder work.
- **Claim latency of routed tasks.** Median and p90 `claimedAt − createdAt` for inferred-role tasks, against role-less tasks over the same window. A routed task that waits noticeably longer than an unrouted one points to a role no runner picks up (§3.2's conservative assumption failing). **A routed task still pending past a fixed ceiling** (proposed: 30 minutes with at least one online runner serving the workspace) raises an alert, rather than waiting for a trend to show it.
- **Override rate.** The share of inferred roles a human changed or cleared. If this rises above the benchmark's error rate, the threshold is wrong for live traffic.
- **`lost_race` rate.** From (c). This drives Open decision 5.

The role histogram's attribution bug is fixed already (reviewers now show as `Reviewer`), so the baseline is clean.

## Implementation sketch

In order, load-bearing piece first. Each numbered item is one PR.

1. **Deterministic role sites (§1).** One builder task per "yes" row. Independent of everything below, and each one shrinks `(unassigned)` with no model involved.
2. **Model precedence (§4.3, §4.2 part 1, §3.1's `roleFloorMap` keying).** `tasks.tier` beats a role exact id; the preview reads the stated role; the floor map resolves per task workspace. Update `docs/specs/model-routing-and-tiers.md` in the same PR.
3. **Role routing fields (§2).** `metadata.routing` read/write, `register_skill`/`update_skill` params, `DefaultRole` fields, and the backfill script (run manually).
4. **`opt_in` capability kind and `task_role_shadow` (§6(a)).** Candidate builder (§3), question and state builders (§5), shadow module, telemetry. Unit tests: candidate filters (one per filter, positive and negative), dynamic question shape, state never includes `context`, the silent-by-default paths, never writes.
5. **Operator step (§6(b)).** Label, benchmark and pick thresholds for both shadows together.
6. **`task_role_apply` (§6(c)).** Guarded write, `context.roleInferred`, claim route ignores the inferred role's model (§4.1), preview line (§4.2 part 2), usage-stats split (§6(d)).

## Open decisions for Max

1. **Should an inferred role's model ever apply?** I lean **no**, as specified (§4.1). The inferred role is persona-only, and a team that wants the floor states the role. The alternative is to apply it as a floor capped at the matrix tier + 1, with the preview line. It is more useful, but it reintroduces the stacking question and makes the preview wrong until the decision lands.
2. **How is "off by default" expressed?** I lean toward a new `opt_in` capability kind plus a `teams.enabledDecisionShadows` column. The alternatives are a hard-coded env allowlist (no migration, but not per-team), or accepting `built_in` (on for every team with a key, which contradicts the brief).
3. **`none` as a label.** I lean **no** (§3), per `decision-calls.md` Point 7 rule 2 and the chat workspace question. If benchmark data shows a large share of role-less tasks that no role should take, revisit with a *defined* label ("bookkeeping: records or reconciles state, produces no deliverable"), not a catch-all.
4. **Persist `availableSkills` on `worker_heartbeats`?** I lean **not yet**. The conservative filter (§3.2) is exact for every runner buildd ships. Persisting it is the right move the day a runner restricts legacy slugs, and the claim-latency metric (§6(d)) is how we would notice.
5. **A claim hold for role-less tasks while the decision runs?** Decide on the shadow's `claimedBeforeDecision` rate. If most tasks are claimed before the decision returns, apply is pointless without a hold of a few seconds, and that delays every role-less task for everyone.
6. **Seeded Builder's `opus` floor.** Independent of routing, but routing makes it matter more once humans confirm inferred roles. Keep `premium`, move to `inherit`, or move to `standard`? This is a cost decision.
7. **A dedicated `roleClassifiedBy` column?** I lean **no** for now. `context.roleInferred` is enough for the usage-stats split. Add a column only if the split needs an index at volume. What is not acceptable is overloading `classifiedBy` (§6(c)).
8. **Adopted PR rows: a role, or `taskClass: 'bookkeeping'`?** The brief suggests giving them the workspace's `reviewerRole`. I lean toward **bookkeeping, no role** (§1 row 7). The adopted row is a completed placeholder that no worker runs, and the review it triggers already carries `reviewerRole`. Labelling the placeholder too would count one review twice in role views.

## Prior knowledge reused

These are from `recall` over memory, tasks, docs and spec. Each claim was re-checked against the code before it was used, and three had gone stale.

- **Claim-filter gotcha.** Do not infer `roleSlug` from `kind` or title, because a slug no runner advertises is unclaimable. This is the basis of §3.2. *Stale detail:* the filter now lives in `role-gate.ts` with the explicit/legacy split, not the single `IN availableSkills` clause at `claim/route.ts:488`.
- **Role histogram attribution.** Reviewer workers folded into their parent's bucket. *Since fixed:* `Reviewer` is now its own group in `get_usage_stats`.
- **Retry sites dropping `roleSlug`.** Fixed by `attempt-identity.ts`. §1 row 8 lists the sites that fix did not reach.
- **Heartbeat instructions keyed on role content.** Seeded rows never pick up `default-roles.ts` edits. That is the basis of §2's backfill.
- **`checkConnectorRouting` typed failures** (#1812). The basis of §3.3. *Stale detail:* the function now lives in `claim/connector-gate.ts`, not `lib/claim-gates.ts`.
- **Team-level role scoping.** The recon behind it described roles as per-workspace with `UNIQUE(workspaceId, slug)`. *Superseded:* #1004 made roles team-level with workspace overrides, and #1012 added the override editor. §3.1 uses the shipped rule.
- **The routing-preview task** (#2616). The basis of §4.2 and §4.5.
- `docs/design/decision-calls.md` Points 2, 3, 7, 8 and 9. `docs/specs/model-routing-and-tiers.md`, "Claim-time model resolution".

## Non-goals

- **Code changes.** This is the spec. Each numbered implementation step is its own PR.
- **Changing what any role does.** No edits to role `content`, tools or connectors. §2 adds routing text, and §4.4 lists model values without changing them.
- **The team-level role scoping migration.** It has shipped (#1004). This design only consumes its resolution rule.
- **A generative-model classifier.** Routing is a decision call with a code fallback, never `inferenceCall`.
- **Routing a task that already has a role**, including re-routing a stated role the model disagrees with. The stated-role sample in §6(a) is for measurement only.
- **Inferring `complexity`, or applying an inferred `kind`.** Both move the model and need their own shadow and gate (§4.5).
- **Chat role selection** (`docs/design/chat-roles.md`). That is about who you talk to. This is about who does a filed task.
