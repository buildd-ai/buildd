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
import { releaseSubscribers } from '@/lib/release/subscribers';
import { chatSubscribers } from '@/lib/chat/subscribers';
import { notificationSubscribers } from '@/lib/notification-subscribers';
import { roleSubscribers } from '@/lib/default-roles-subscribers';

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
  ...roleSubscribers,
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
