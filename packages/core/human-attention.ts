/**
 * Human attention: the pure half of "may this reach a person, and with what".
 *
 * Two rules, both deterministic (no model call):
 *
 * 1. **Recover before asking.** A question whose own text describes a
 *    deterministic, recoverable platform blocker (a migration below the
 *    high-water mark, a merge conflict with the base, missing generated state,
 *    a transient 5xx/rate limit, CI that is red on the base and not because of
 *    this change) has an obvious answer: fix the platform. Asking a person for
 *    permission to do that is a page with no decision in it. The question gate
 *    (apps/web/src/lib/question-gate-check.ts) files or reuses a repair task
 *    and answers the agent itself. A hard rail
 *    (`detectHardRail` in ./question-gate.ts) always wins: those still ask.
 *
 * 2. **Never a context-free card.** When a question does reach a person, every
 *    surface renders the same normalized question
 *    (apps/web/src/app/app/(protected)/tasks/[id]/question-hero.ts
 *    `unifyWorkerQuestion`). If the brief carried no context, the context is
 *    rebuilt from what the worker already reported (its `needs_input:` error
 *    holds the full question text, framing included) or, failing that, the
 *    task it was asked on. Fail-open keeps the question flowing; it does not
 *    get to drop what we know.
 *
 * Safe to import from client components.
 */
import { clampContext, splitQuestionText } from './question-brief';

export type RecoverableBlockerKind =
  | 'migration_order'
  | 'merge_conflict'
  | 'missing_generated'
  | 'platform_retryable'
  | 'ci_failure';

export interface RecoverableBlocker {
  kind: RecoverableBlockerKind;
  /** Plain words for the blocker, used in the repair task and the agent's answer. */
  label: string;
}

const LABELS: Record<RecoverableBlockerKind, string> = {
  migration_order: 'a migration ordering problem',
  merge_conflict: 'a merge conflict with the base branch',
  missing_generated: 'missing or stale generated files',
  platform_retryable: 'a transient platform error',
  ci_failure: 'CI that is already failing on the base branch',
};

const MIGRATION_ORDER = [
  /\bmigrations?\b[^?]{0,160}\b(?:high[- ]water|out[- ]of[- ]order|index collision|collides|renumber)/i,
  /\bhigh[- ]water mark\b[^?]{0,80}\bmigrations?\b/i,
];
const MERGE_CONFLICT = /\bmerge conflicts?\b|\bconflicts? with (?:the )?(?:base|dev|main|trunk)\b/i;
const MISSING_GENERATED = /\b(?:generated|codegen|snapshot|lockfile|journal)\b[^.?!]{0,60}\b(?:missing|stale|out of date|not (?:been )?generated|absent)\b/i;
const PLATFORM_RETRYABLE = /\b(?:HTTP\s?5\d\d|50[234]|ECONNRESET|ETIMEDOUT|service unavailable|rate[- ]limit(?:ed)?)\b/i;
const CI_SUBJECT = /\b(?:CI|build|tests?|type[- ]?check|lint)\b/i;
const CI_RED = /\bfail(?:s|ed|ing|ure)?\b|\bred\b|\bbroken\b/i;
/** Only a failure that is not this change's: unrelated, pre-existing or already red on the base. */
const CI_NOT_OURS = /\b(?:unrelated|pre-?existing|already (?:failing|red|broken)|on (?:the )?(?:base|dev|main|trunk)\b|flaky)/i;

function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** The recoverable blocker a question's visible text describes, or null for a real decision. */
export function classifyRecoverableBlocker(text: string | null | undefined): RecoverableBlocker | null {
  if (!text?.trim()) return null;
  const pick = (kind: RecoverableBlockerKind): RecoverableBlocker => ({ kind, label: LABELS[kind] });
  if (MIGRATION_ORDER.some(re => re.test(text))) return pick('migration_order');
  if (MERGE_CONFLICT.test(text)) return pick('merge_conflict');
  if (MISSING_GENERATED.test(text)) return pick('missing_generated');
  if (PLATFORM_RETRYABLE.test(text)) return pick('platform_retryable');
  if (sentences(text).some(s => CI_SUBJECT.test(s) && CI_RED.test(s) && CI_NOT_OURS.test(s))) return pick('ci_failure');
  return null;
}

const TITLES: Record<RecoverableBlockerKind, string> = {
  migration_order: 'fix(migrations): unblock a migration below the high-water mark',
  merge_conflict: 'fix: resolve the base-branch conflict blocking a task',
  missing_generated: 'fix: regenerate missing generated state blocking a task',
  platform_retryable: 'fix: transient platform error blocking a task',
  ci_failure: 'fix(ci): base branch CI failure blocking a task',
};

export interface RepairTaskSpec {
  title: string;
  description: string;
  /** Subject-anchor error signature: one live repair per blocker kind per scope. */
  signature: string;
}

/**
 * The repair task for a blocker. `scopeId` is the mission when there is one,
 * else the workspace, so every task blocked by the same thing shares one repair.
 */
export function repairTaskSpec(
  blocker: RecoverableBlocker,
  ctx: { scopeId: string; blockedTaskId?: string | null; blockedTaskTitle?: string | null; evidence?: string | null },
): RepairTaskSpec {
  const evidence = ctx.evidence?.replace(/\s+/g, ' ').trim().slice(0, 1200);
  const blocked = ctx.blockedTaskId
    ? `- Blocked task: ${ctx.blockedTaskTitle ? `"${ctx.blockedTaskTitle}" ` : ''}(${ctx.blockedTaskId.slice(0, 8)})`
    : null;
  const description = [
    `An agent stopped to ask a person about ${blocker.label}. That has an obvious repair, so no one was paged; this task is the repair.`,
    '',
    blocked,
    evidence ? `- What the agent reported: ${evidence}` : null,
    '',
    'Fix the blocker itself, not the blocked task. When it lands, the blocked task can be retried.',
  ].filter(l => l !== null).join('\n');
  return { title: TITLES[blocker.kind], description, signature: `recoverable-blocker:${blocker.kind}:${ctx.scopeId}` };
}

/** The AskUserQuestion tool result the agent gets instead of a person's answer. */
export function recoveredAnswerText(
  blocker: RecoverableBlocker,
  r: { repairTaskId: string; reused: boolean; recommended?: string | null },
): string {
  const id = r.repairTaskId.slice(0, 8);
  const next = r.recommended
    ? `Continue with your recommended option: ${r.recommended}.`
    : 'Continue with whatever does not depend on it.';
  return `Not sent to a person: this is ${blocker.label}, which has an obvious repair. Repair task ${id} ${r.reused ? 'is already open' : 'was filed'} for it. Do not wait on it here. ${next} If nothing can go ahead without it, finish and say in your result that the work is blocked on repair task ${id}, so this task can be retried once that lands.`;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Context for a question whose brief has none: from the worker's own error
 * (a `needs_input:` error carries the full question text, framing included;
 * any other error is itself what failed), else the task it was asked on.
 * Never a placeholder: absent when there is nothing to say.
 */
export function fallbackQuestionContext(input: {
  prompt: string;
  context?: string | null;
  workerError?: string | null;
  taskTitle?: string | null;
}): string | undefined {
  const own = clampContext(input.context);
  if (own) return own;
  const raw = input.workerError?.trim();
  if (raw) {
    const isAsk = /^needs_input:/i.test(raw);
    const rest = raw.replace(/^needs_input:\s*/i, '').trim();
    if (rest && norm(rest) !== norm(input.prompt)) {
      const fromAsk = isAsk ? splitQuestionText(rest).context : clampContext(rest);
      if (fromAsk) return fromAsk;
    }
  }
  const title = input.taskTitle?.replace(/\s+/g, ' ').trim();
  return title ? `Asked while working on "${title}".` : undefined;
}

/** True when a person would see only the question: no context, no default, no option says what it leads to. */
export function isContextFree(q: {
  prompt: string;
  context?: string | null;
  recommended?: { label: string } | null;
  options: ReadonlyArray<{ description?: string; consequence?: string }>;
}): boolean {
  if (q.context?.trim()) return false;
  if (q.recommended?.label) return false;
  return !q.options.some(o => (o.consequence ?? o.description)?.trim());
}
