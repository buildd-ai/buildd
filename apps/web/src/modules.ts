/**
 * Composition root: the one place optional modules are wired into core.
 *
 * Core code never imports a module (scripts/module-boundaries.test.ts). It
 * emits core events (lib/core-events.ts, lib/core-emit.ts) and this list says
 * who reacts. It is code, not configuration: no env var turns a module on or
 * off. A deployment that does not use a module runs the same build with that
 * module's tables empty, and its subscribers are no-ops.
 *
 * Order is load-bearing within an event type: subscribers run in list order.
 * `modules.test.ts` pins the order per event.
 */
import type { AnySubscriber } from '@/lib/core-events';
import { decisionSubscribers } from '@/lib/decision-subscribers';
import type { CompletionPolicies } from '@/lib/completion-policy';
import { visualAuditEvidencePolicy } from '@/lib/visual-audit-evidence-policy';
import { loopPolicy } from '@/lib/loop-dispatcher-policy';
import { releasePolicy } from '@/lib/release-completion-policy';
import { knowledgeSubscribers } from '@/lib/knowledge-subscribers';
import { missionSubscribers } from '@/lib/mission-subscribers';
import { reviewSubscribers } from '@/lib/review-subscribers';
import { reviewerSubscribers, reviewerDispatchOnOpen } from '@/lib/reviewer-subscribers';
import type { PrOpenedPolicy } from '@/lib/pr-opened-policy';
import type { EffectHandlers } from '@/lib/workflow/effects';
import { reviewEffectHandlers } from '@/lib/workflow/review-effects';
import { releaseSubscribers } from '@/lib/release/subscribers';
import { chatSubscribers } from '@/lib/chat/subscribers';
import { notificationSubscribers } from '@/lib/notification-subscribers';
import { roleSubscribers } from '@/lib/default-roles-subscribers';
import { connectorCatalogSubscribers } from '@/lib/connector-catalog-subscribers';
import { routingAnalyticsSubscribers } from '@/lib/routing-analytics-subscribers';

export const SUBSCRIBERS: readonly AnySubscriber[] = [
  // task.created: the category look is scheduled before the mission chain starts.
  ...decisionSubscribers,
  ...knowledgeSubscribers,
  ...missionSubscribers,
  // pr.closed: the surface settle is scheduled before the review reactions.
  ...reviewSubscribers,
  // pr.merged: the release record is kicked off before the ledger write.
  ...releaseSubscribers,
  // Before notifications: on a completion the chat post was kicked off first.
  ...chatSubscribers,
  ...notificationSubscribers,
  // pr.ci_failed: the ledger records the red head before the CI-fix retry is asked.
  ...reviewerSubscribers,
  ...roleSubscribers,
  ...connectorCatalogSubscribers,
  // A held release's outcome-analytics row, recorded when its CI resolves it.
  ...routingAnalyticsSubscribers,
];

/**
 * Completion policies, one per core-declared slot (lib/completion-policy.ts).
 * Not subscribers: each returns a verdict the worker PATCH applies, so the
 * PATCH stays the one place a task's terminal status is decided. The slot
 * order (evidence, loop, release) is core's, not this object's.
 */
export const COMPLETION_POLICIES: CompletionPolicies = {
  evidence: visualAuditEvidencePolicy,
  loop: loopPolicy,
  release: releasePolicy,
};

/**
 * The PR-opened slot (lib/pr-opened-policy.ts): the reviews module may take a
 * freshly opened worker PR, and a PR it holds skips core's no-CI auto-merge.
 */
export const PR_OPENED_POLICY: PrOpenedPolicy = reviewerDispatchOnOpen;

/**
 * The workflow kernel's effect handlers (lib/workflow/effects.ts). The kernel
 * (core) decides and records the effect; the reviews module carries out the
 * review-loop ones (reviewer and fix tasks, GitHub reviews, escalations).
 */
export const WORKFLOW_EFFECT_HANDLERS: EffectHandlers = reviewEffectHandlers;
