# One Jev gate for human questions

**Status:** Proposed
**Related:** `docs/design/decision-calls.md`, `docs/specs/human-in-the-loop-protocol.md`, `packages/core/decision-client.ts`, `packages/core/orchestration-decision.ts`, `packages/core/orchestration-ledger-source.ts`; knowledge-base: buildd/design/subscriptions-and-notifications.md. Shared decision-ledger dependency: task `1ba1374e`.

## Problem

A protected-path landing failure offered a person “Retry landing” even though retrying the same commit could never succeed. `apps/web/src/lib/pr-landing-alert.ts` now correctly offers only `review_on_github` for `deny_path` and `migration`. The broader problem remains: independent producers decide when to interrupt a person, and dashboard cards can surface those requests even when no notification was sent.

The owner principle is universal: every question, page, action card and notification Buildd sends to a human passes through Jev's gate first. Jev decides an authorized action, holds the request with a bounded return condition, or asks with a decision brief. This contract ships live with durable logging from the first migrated path. No experiment enrollment, shadow phase or default-off switch is a prerequisite. This explicitly supersedes the old shadow-first notification proposal and the no-op rollout default in `docs/design/DESIGN-FORMAT.md` for this capability.

This document is the explicitly requested public contract at this path; other design prose retains the private knowledge-base boundary. It describes proposed behavior, not behavior already implemented.

## Current state and inventory

Paths below are relative to the repository root and were checked against this checkout. Rows group producers with their fan-out: each listed producer must obtain the same persisted gate result before its downstream surfaces present a request. Realtime transport is not permission to display it.

| Family | Producers / policy today | Human surfaces / delivery today |
| --- | --- | --- |
| Agent questions, main session | `apps/runner/src/hook-factory.ts` PreToolUse; `apps/runner/src/workers.ts` question parking and message handling; `apps/runner/src/question-gate.ts` | `apps/web/src/app/api/workers/[id]/route.ts` stores `waitingFor`, emits needs-input and notifications; `apps/web/src/components/NeedsInputProvider.tsx` browser notifications |
| Question clarity experiment | `apps/web/src/app/api/workers/[id]/question-check/route.ts`, `apps/web/src/lib/question-gate-check.ts`, `packages/core/question-gate.ts`, `apps/web/src/app/api/workers/claim/question-gate.ts` | Only enrolled runner questions: `actionable` sends; `needs_context` can push back twice. Control checks are shadow. This is not a decide/hold/ask gate |
| SDK permissions and background agents | `apps/runner/src/hook-factory.ts` PermissionRequest and `canUseTool`; main/background AskUserQuestion have special allow paths | Worker PATCH and `apps/web/src/components/WorkerRespondInput.tsx`; background question path is not covered by the existing clarity experiment |
| Agent notes / planning questions | `apps/web/src/app/api/tasks/[id]/notes/route.ts`, `apps/web/src/app/api/missions/[id]/notes/route.ts` (also reached by MCP `post_note`); `apps/web/src/lib/task-dependencies.ts` extracts structured planning questions | Task/mission feeds and `apps/web/src/lib/chat/mission-events.ts` question event; `apps/web/src/lib/chat-objects/load-question-object.ts` |
| Shared question presentation | `apps/web/src/app/app/(protected)/tasks/[id]/question-hero.ts` unifies worker and note questions | `QuestionHero.tsx` in that directory, task detail and its `respond/page.tsx`; chat/feed question objects; `apps/web/src/components/WorkerRespondInput.tsx` mission panel |
| Landing pages and one-tap links | `apps/web/src/lib/pr-landing-alert.ts`, `pr-landing-alert-deps.ts`, `pr-landing-sweep.ts` in the same directory | `apps/web/src/lib/notify.ts`; `apps/web/src/lib/landing-action.ts`, `landing-action-run.ts`, `landing-action-token.ts` build/confirm/run signed actions |
| Reviewer escalations and retry exhaustion | `apps/web/src/app/api/workers/[id]/route.ts` reviewer outcome; `apps/web/src/lib/auto-merge.ts`, `conflict-retry.ts`; `apps/web/src/app/api/workers/[id]/interrupt/route.ts`; `apps/web/src/app/api/github/webhook/route.ts` | Reviewer notes, team alerts, `apps/web/src/app/api/prs/escalation-inbox/route.ts`; `apps/web/src/lib/reviewer-gate.ts` `resolveReviewerGate` and `reviewer-evidence.ts` feed `apps/web/src/components/WaitingOnYouReviewCard.tsx` |
| Home action queue, including approval, reconnect and discrepancy | `apps/web/src/app/app/(protected)/home/page.tsx`; `apps/web/src/lib/action-queue.ts` derives MERGE, REVIEW, QUESTION, DECIDE, APPROVE, RECONNECT, BLOCKED, DISCREPANCY and stale states | `apps/web/src/app/app/(protected)/home/ActionQueueCard.tsx`, `apps/web/src/components/WaitingOnYouDecideCard.tsx`; snooze via `apps/web/src/app/api/action-queue/snooze/route.ts` |
| Mission criteria decisions and visual review | `apps/web/src/lib/criteria-rearm.ts`, `criteria-escalation-note.ts`, `mission-surface-audit.ts` (visual round-cap question) | Mission detail/feed/timeline and `apps/web/src/app/app/(protected)/missions/[id]/MissionDecisionSheet.tsx`; chat mission questions |
| Mission PR / budget / stalled organizer | `apps/web/src/lib/mission-notifications.ts`, `mission-budget.ts`, `heartbeat-circuit-breaker.ts` | Team `needsAttention` alerts and mission state/banners; resolve the same request identity as its DECIDE card when applicable |
| Task start prompts | `apps/web/src/app/api/tasks/[id]/start/route.ts`; claim policies in `apps/web/src/app/api/workers/claim/` | `apps/web/src/app/app/(protected)/missions/[id]/TaskActionZone.tsx`; policy versus capability response shapes determine force/remediation actions |
| Task lifecycle notifications and watched task/PR events | `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/github/webhook/route.ts`; `apps/web/src/lib/pr-reconcile.ts`, `pr-state-refresh.ts`; `apps/web/src/lib/subscriptions.ts` `recordEvent` | `apps/web/src/lib/notify.ts` / `notify-rules.ts` team Pushover + webhook; subscriptions' `notification_deliveries` ledger |
| Watch conversation, inbox and away push | `apps/web/src/lib/chat/watch-delivery.ts` posts conversation records independently of delivery; `apps/web/src/lib/notify-away-queue.ts` queues due rows | `apps/web/src/lib/away-delivery.ts`, `personal-pushover.ts`, `pushover.ts`; `apps/web/src/app/api/cron/notify-away/route.ts`; `apps/web/src/components/chat/use-watch-delivery.ts` |
| Credentials and connectors | `apps/web/src/app/api/workers/claim/connector-block-notify.ts`; `apps/web/src/app/api/runner/credential-refresh/route.ts`; worker PATCH credential failure handling | Team credential/reconnect notices; `apps/web/src/app/api/cron/connector-block-notify/route.ts`, `codex-token-refresh/route.ts`, `lease-expiry-guard/route.ts`; Home RECONNECT |
| Operational pages and reminders | `apps/web/src/lib/health-watcher.ts`; `apps/web/src/app/api/github/webhook/dark-check-detection.ts`; webhook watchdog/escalation branches; `packages/core/report-ops.ts` platform Pushover | `apps/web/src/lib/notify.ts`; `apps/web/src/app/api/cron/stall-notify/route.ts`, `experiment-health/route.ts`; platform reports must use the operator owner, not a tenant channel |
| Chat clarification and approval requests | `apps/web/src/lib/chat/tools.ts` unresolved target / preview clarification; `apps/web/src/lib/chat/turn.ts`, `approvals.ts` tool approval requests | Chat stream and approval cards; model-generated follow-up questions must be classified before streaming to a person, including routing ambiguity |

Ingress and egress coverage both matter. User-triggered buttons need no model call merely to exist, but a generated block dialog or requested approval does. Ordinary facts and user-initiated navigation remain readable; outbound informational notifications still get a gate record and may be batched. Human-authored messages are not rewritten. Buildd-generated questions in prose are not an escape hatch: buffer and classify them before streaming. Passive audit views of held/decided requests are permitted only through the recorded gate disposition; they must not recreate an ungated action queue.

Inventory acceptance is a source audit of all `notifyTeam` / `notifyTeamOf`, direct Pushover/webhook/browser sends, worker waiting-state writes, question-note inserts, chat approval/clarification emissions and queue builders. Every source gets an adapter or an explicit factual-display classification. New sources must register with a coverage test. Channels and UI components are consumers, not separate decision-makers.

## Proposal

The crux is **one durable request and one effective decision shared across every surface**, rather than one call per channel. Otherwise a held push can still appear as a question card, or Jev can answer twice and resume a worker twice.

Introduce a server-owned `human_question_gate` capability and proposed `routeHumanRequest` service. Producers submit a typed envelope; the service computes deterministic eligibility, calls the existing decision client, validates the result, records it, and issues a gate receipt. Only consumers with that receipt may render or send a generated request. Runners use an authenticated server adapter; the worker PATCH remains authoritative for old runners and background questions. Receipt reuse is scoped to owner, request revision and evidence fingerprint, not arbitrary client claims.

### Input

- Identity: stable `requestId`, revision, producer family, team/workspace, subject refs, correlation/dedupe key, timestamp and expiration. Use worker tool-use identity, note identity, or PR/head/reason identity rather than paraphrased model text as the key.
- Question: original text and a brief with context, per-option consequences and recommended default. Keep an immutable original and separately record any brief enrichment. Evidence-derived text only; missing information is named, never invented.
- Evidence: authorized references plus bounded summaries, current subject version/head, known uncertainty, prior attempts, active fixes/reviews, recent related deliveries, and deadlines. Fingerprint both evidence and candidate actions.
- Available actions: server-produced action IDs, consequence, typed parameters, permission/risk classification, preconditions, outcome-changing reason, idempotency key, and compensation/override route where possible. Unknown actions are ineligible for decide.
- Owner: authenticated person or explicit team/operator recipient policy, membership scope and routing preferences. Never let an agent or the model nominate an unrelated recipient or widen access.
- Constraints: deadline, urgency ceiling, own-task needs-input status, subscription intent, sensitive-data policy, spending reservation, minimum confidence and hold ceiling.

No credential values, raw tokens or unnecessary repository content enter the prompt. Sensitive workspaces use redacted evidence or deterministic `ask`; the gate is still traversed and recorded. A missing owner creates a pending operational incident and scoped inbox record, never a fallback to another team's channel.

### Output and application

Jev returns typed labels and indices, not generated rationale prose: disposition `decide | hold | ask`, candidate action index, hold-condition index and reason-code index. The server builds the brief from those codes and evidence. Confidence defaults to 0.85 for decide and hold; this is an initial policy choice, not a measured calibration claim. Below threshold, invalid labels or unknown evidence means `ask`.

| Disposition | Required effect | What the person can see/do |
| --- | --- | --- |
| decide | Apply one explicitly permitted action through the existing guarded executor; persist success/failure and link the resumed worker, note resolution or dispatched fix | Passive “Jev decided” history with evidence and consequence; human can re-answer or compensate under the current permissions |
| hold | Persist request, reason, destination (`inbox/digest` or evidence wait), event predicate and absolute `resurfaceAt`; register both event wake and deadline sweep | Held inbox/digest entry states why and when it returns; owner can ask now, change the answer or cancel |
| ask | Persist an actionable brief and dispatch to the owner's configured routes; all cards/chat/push share its version and action set | Context, evidence, options with consequences, recommendation and a specific explanation of why only this person can decide |

For decide, reserve/record intent before execution and atomically claim the idempotency key. Mark `applied` only after executor success, with a result reference. Ambiguous execution must be reconciled using that key before retry; it is never repeated blindly. A stale head/evidence revision or lost precondition returns to `ask` with current actions. Human answers race against model application using an atomic version/status predicate; first successful commit wins. Later overrides append to the same record and may resume/re-answer through existing guarded paths. “Override” never promises reversal of an irreversible operation.

For hold, initial ceilings are 15 minutes for blocking own-task input, 30 minutes for landing/reviewer requests, and 24 hours for informational digests; an earlier subject deadline always wins. Own-task needs-input cannot be dropped, hidden from its held inbox, or postponed repeatedly beyond its original ceiling. Examples: new head or finished CI, fix pickup, refreshed connector, extra evidence, owner return, or digest due. Wake re-evaluates a new evidence revision once; unchanged evidence at the absolute ceiling becomes `ask`, not another hold. A resolved/superseded request closes with a recorded factual resolution. Cancellation is explicit and audited, never model `drop`.

For ask, a brief starts with one or two sentences naming the work and the decision, then the question. Each option states its effect in one line. A recommendation is marked and explained. “Only a person” names the exact rail, missing authority, preference, irreversible tradeoff or unavailable evidence; low confidence and provider failure are explicitly stated fallback reasons. Missing brief context may trigger at most two bounded requests for evidence from the agent within the original hold deadline; failure still asks with the facts available. There is no infinite clarity loop.

### Deterministic rails and meaningful actions

The server computes rails before inference and rechecks them at execution. Jev cannot turn a deterministic prohibition into permission, relax the human's permissions or raise urgency. If any request involves a rail below, **decide is unavailable for that request**; Jev can hold/batch it within bounds, or attach a recommendation and ask. A harmless fix proposal must be a separate request with its own explicit authorization and budget.

| Rail | Permitted human route / alternative |
| --- | --- |
| Protected paths, CI/deploy workflow changes, migration/schema changes | Review exact diff through the existing human route; do not invoke merge-anyway or retry the unchanged deterministic denial |
| CI red/unknown, branch protection, required review, human merge tier, unverified/stale head or base | Preserve existing landing/merge enforcement. Obtain missing evidence/review or propose a fix; retry only after a named state change can clear the block |
| Auth, secrets, credential scope, security concerns, session-wide tool permissions | Authorized person reconnects/configures/approves; Jev never writes secrets, expands tools or chooses “Always allow” |
| Spending, budget/cap increases, paid starts, purchases or provider changes that increase spend | Person authorizes the exact bounded change; Jev cannot force-start past budget, account/session pressure or capacity limits |
| Dependency/claim conflicts, serialized surfaces, held missions, dead subjects or capability failures | Do not bypass dependencies, claims or holds. Offer an actual remediation: wait, change configuration with permission, reconnect, or explicitly select an available backend |
| Goal/acceptance changes, waive findings, destructive or irreversible changes | Person owns accepting reduced scope, visual waiver, delete/close or changed success criteria; Jev can summarize evidence and recommend |

The start gate already returns `blockClass: policy | capability` (PR #1858). Policy is not blanket Jev authority: an explicit held mission or exhausted budget remains a rail. Capability blocks never offer force-start. Available backends and reconnect actions come from current server checks. A force action is offered to a human only where that executor actually supports the override.

Action filtering applies to human options too. A retry requires a transient condition or changed evidence that can change the outcome. `deny_path`/migration on the same head shows review on GitHub, as the current landing rule does; missing credentials shows reconnect/configure or a genuinely available backend. Buttons are revalidated at click time; signed links are bound to receipt/action/revision/owner and expiration. No model can mint arbitrary URLs or executor parameters.

### Fail-open, cost and delivery reliability

Fail-open means **ask through the gate's deterministic fallback**, never bypass the gate or silently lose the request. Timeout, thrown error, missing key, denied inference access, unavailable model, low confidence, malformed verdict, exhausted cost cap, record-write failure or gate-service outage all select `ask`. Existing action rails and channel/privacy rules still apply. Do not inherit a generic rule fallback that retries a deterministic block.

Use one overall 3-second server decision deadline and a 4.5-second runner transport deadline, matching the current clarity gate's bounds. At most one transient retry may fit inside the server deadline. One paid evaluation per owner/request/evidence revision; tabs, render passes, retries and channel fan-out reuse it. Re-evaluation requires materially changed evidence or the due hold transition, never a polling tick.

Initial ceilings: 2,000 input tokens and 128 output tokens per evaluation, a conservative maximum USD 0.01 reservation per request evaluation, and USD 1 per team per UTC day. Enforce the lower of these limits and existing team inference/budget policy, atomically reserve before spend, then settle using the actual receipt. Unknown price or inability to reserve means ask. The gate cannot itself increase these caps. Store tokens, latency, actual cost and reservation disposition once through the shared usage receipt; do not double-count conversation and AI usage. These are proposed bounds, not observed costs.

Store the request and decision plus dispatch intent durably before marking sent. Use an outbox and retry lease, not today's fire-and-forget completion marker as proof of delivery. On ledger failure no automatic decide or hold is allowed: attempt immediate safe ask, keep a retryable source/outbox fallback marker, and raise a scoped operational fault. Recover missing ledger records by idempotent replay. If all persistence/transport is down, do not acknowledge delivery; source remains pending and retries after recovery. Fail-open cannot guarantee a push during a total outage, but must not record a false success.

Preferences and channel routing stay deterministic: no urgency above `maxUrgency`, no cross-team fallback and no secret disclosure. With no usable channel, ask remains actionable in the scoped inbox; invalid membership reveals nothing and routes an operator incident. A one-shot watch also traverses the gate, unlike the old exemption: its explicit delivery intent forces ask/delivery rather than semantic suppression. Informational notifications without actions cannot select decide. Subscription consumption happens after confirmed delivery or a recorded successful resolution, never merely because Jev held the row. Chat records, browser events, inbox cards and push all consume the same receipt; raw waiting-state Pusher events must not trigger an ungated browser notification.

### Shared decision record

Task `1ba1374e` owns the shared ledger. Its implementation is not assumed landed in this checkout. Agree and extend that envelope before building this adapter; do not create an independent question-only decision ledger. Existing orchestration fields (`decisionId`, `decisionVersion`, `fingerprint`, `ruleVerdict`, `suggested`, `confidence`, `effective`, `applied`, `status`) provide the compatibility vocabulary. Distinguish the definition fingerprint from the input fingerprint.

Required common fields:

- Identity/scope: record ID, request/correlation ID, revision, capability `human_question_gate`, producer, owner ref, team/workspace and optional task/worker/mission/PR/head refs, created/decided timestamps.
- Policy/input: decision definition ID/version/fingerprint, model actually served, policy/rail versions, input/evidence fingerprint, candidate digest/version, bounded authorized evidence references, question/brief reference, threshold and confidence distribution when available.
- Decision: `ruleVerdict` (safe ask), model `suggested` verdict/action/hold reason, confidence, final `effective` disposition/action, `applied`, status, blocked rails, fallback/error reason. An executor failure is distinguishable from a model fallback and a successful decide.
- Effects: application intent/result/error and idempotency key, selected routes, outbox/delivery attempts/receipts, hold condition and absolute due time, wake/resolution reason; links to usage receipt, latency/tokens/cost.
- Review feedback: append-only human override events with actor, previous/new answer, reason, time and executor result; later outcomes such as useful answer, reopened request, deterministic retry, duplicate page, timely resurface, hold overdue, compensation or unresolved. Unknown outcomes are marked missing/censored rather than inferred as success.

Query one shared read interface by team/owner scope, capability, producer, time window, fallback, applied-versus-rule disagreement, human overrides and overdue holds. Stable cursor pagination and an as-of boundary let one logical weekly query retrieve the complete window plus older holds/decisions with new outcomes; never silently truncate. Counts include deterministic fallbacks and no-spend evaluations. Sensitive content remains behind workspace authorization/redaction; records and operational logs contain no raw credentials. The reviewer receives resolvable evidence references only within its authorized scope.

### Migration plan

Priority below is an initial estimate from code fan-out, not a measured production volume claim. First read a scoped, content-free week of source/delivery counts and reorder by actual distinct requests, interruptions and duplicate fan-out. Do not publish those counts here. Each slice enables live decisions and logs every path as it lands; no shadow stage. Overall coverage is incomplete until every row is migrated.

1. Shared request/receipt, rails, ledger adapter, cost reservation, outbox, hold sweeper and receipt coverage contract. Coordinate with `1ba1374e`; acceptance includes unavailable-ledger ask fallback and idempotent execution. No UI should infer hold/ask independently.
2. High fan-out worker questions and lifecycle/notification delivery: worker PATCH, all main/background hooks and permissions, browser notifications, team/webhook sends, subscriptions, chat watch posting and away push. Gate once at semantic ingress, enforce receipts at all egress. Replace the clarity experiment's routing authority with bounded brief enrichment; preserve stored experiment history without shadowing the new gate.
3. Landing/reviewer requests: landing page producer/confirm actions, auto-merge/conflict/watchdog escalations, stall reminders, escalation inbox and Home review queue. Keep `resolveReviewerGate` as the deterministic ownership/evidence input; Jev cannot alter its merge rails. Existing queued fixes/reviews prevent duplicate remediation requests.
4. Mission questions/DECIDE/APPROVE/discrepancy and start-gate dialogs: notes and structured planning questions, criteria and visual audit, mission PR/budget/breaker notices, Home builders, task starts. A held request never reappears through a raw open-note or waiting-worker query. Gate old rows lazily or in a bounded backfill before first display; do not hide unmigrated rows on a missing receipt—record fallback ask.
5. Remaining reconnect/credential/health/operator notifications and chat approvals/clarifications, including buffered generated prose. Finish the inventory audit and weekly scheduled review. No direct channel send or action card remains outside a receipt-checking consumer.

Acceptance tests for each slice are written first: authorized decide/resume once; simultaneous human answer; all rail cases; deterministic block action filtering; threshold boundary; timeout/provider/missing-key/cap ask; lost ledger/outbox/delivery recovery; concurrent duplicate fan-out; expired/stale receipt; sensitive tenant isolation; event wake and absolute hold ceiling; old runner/note compatibility; one-shot watch delivery; main/background permission/question paths. Run isolated unit files using `bun run scripts/run-unit-tests.ts`, route tests and queue DOM tests where relevant. Final source coverage audit proves every inventory adapter and consumer is wired, and alerts on missing or unverifiable receipts.

## Weekly review loop

A weekly scheduled reviewer in the linked knowledge workspace reads the shared ledger through one scoped query for the prior UTC week, plus older requests whose outcomes/overrides changed and all overdue holds. Configure the existing task scheduler with a pinned reviewer role, read-only ledger/evidence access, an explicit inference budget, and a versioned review prompt. The gate migration must supply the read action, cursor continuation, stable window and access grants before enabling the schedule.

It needs the original authorized question/evidence, candidate actions and their preconditions, rail/policy version, model verdict/confidence, rule/effective answer, fallback/apply result, actual deliveries, hold/wake/deadline history, human overrides and downstream outcomes. It reports confidence calibration by producer, override and disagreement patterns, avoidable asks, wrongful holds, missed/duplicate pages, useless actions, fallback reliability, cost and completeness. Audit a sample of agreeing decisions too, not only overrides; absence of override is not proof of correctness. Missing evidence and nonresponders remain explicitly censored.

Write a private review artifact with evidence links and bounded proposed policy/test changes. A finding that requires a person's choice itself enters this gate. Any suggested rail, threshold, budget or schedule change is a proposal under normal owner authorization, never automatically applied by the reviewer. Gate failure/overdue hold monitoring runs continuously; it cannot wait a week. Review artifacts and pagination checkpoints permit replay after schedule failure without duplicate reports.

## Open questions

No owner decision blocks this spec. The initial confidence and cost/hold bounds are conservative implementation defaults; the weekly review should propose evidence-based tuning. The exact shared-ledger API/table mapping remains an integration dependency on `1ba1374e`, with the required fields and read contract above. Validate migration ordering using private source-volume evidence before implementing it.

## Non-goals

This planning deliverable does not enable the service, merge permissions, modify credentials or create the review schedule. It does not mediate messages humans send directly outside Buildd, or guarantee reversal of an irreversible action. It does not replace the existing landing, reviewer, claim, auth, budget, subscription/channel or human-answer executors; the gate chooses only within their authorized bounds.
