/**
 * The PRs a task's own records link it to, read without any I/O: the PR its
 * retry attempt is bound to, a PR link the server stamped when it was filed
 * (`context.prReach`, written only by lib/pr-reach-grant.ts), or a person's
 * landing grant. A leaf module, so the task-filing route can use it without
 * pulling in the PR-door graph.
 */
import { readLandingOverrideGrant } from '@/lib/landing-override-grant';

/** The slice of a task row these rules read. */
export interface PrLinkTask {
  context?: unknown;
  reviewerRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  conflictRetryPrNumber?: number | null;
}

/**
 * A PR link the server stamped on a task when it was filed
 * (`context.prReach`). Only `lib/pr-reach-grant.ts` writes it: for a person
 * filing (`human:<userId>`), any PR the filing names; for an agent run filing
 * (`task:<taskId>`), only PRs the filing task could already act on. Every
 * caller-supplied value is replaced at filing, and templates drop it.
 */
export interface PrReachGrant {
  prNumbers: number[];
  grantedBy: string;
  grantedAt: string;
}

/** The PR link a task's context carries, or null when it carries none the server stamped. */
export function readPrReachGrant(context: unknown): PrReachGrant | null {
  const raw = (context as { prReach?: Partial<PrReachGrant> } | null | undefined)?.prReach;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.prNumbers)) return null;
  if (typeof raw.grantedBy !== 'string' || !/^(human|task|system):./.test(raw.grantedBy)) return null;
  return { prNumbers: raw.prNumbers.filter((n): n is number => Number.isInteger(n) && n > 0), grantedBy: raw.grantedBy, grantedAt: String(raw.grantedAt ?? '') };
}

/** The PR a retry attempt is bound to (a server-written column), or null. */
export function retrySubject(task: PrLinkTask): number | null {
  return task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? task.conflictRetryPrNumber ?? null;
}

/** PRs a server-owned link on the task names: its PR link or a person's landing grant. */
export function linkedPrNumbers(task: PrLinkTask): number[] {
  return [
    ...(readPrReachGrant(task.context)?.prNumbers ?? []),
    ...(readLandingOverrideGrant(task.context)?.prNumbers ?? []),
  ];
}

/**
 * The task's own records link this PR: the PR its retry attempt is bound to,
 * a PR link stamped when it was filed, or a person's landing grant on it.
 * Text in the title, description or a caller-written context value never
 * links a PR on its own: that is the filer's word, and a filer could name any
 * PR. The worker's own PR (`workers.prNumber`) is checked by the caller.
 */
export function taskLinksPr(task: PrLinkTask | null | undefined, prNumber: number): boolean {
  if (!task) return false;
  return retrySubject(task) === prNumber || linkedPrNumbers(task).includes(prNumber);
}

/**
 * The PR numbers a task filing names: `#N` or `/pull/N` in its title or
 * description, and `context.prNumber` / `context.prNumbers`. Candidates only:
 * lib/pr-reach-grant.ts decides which of them the filer may link.
 */
export function prNumbersNamedAtFiling(f: { title?: string | null; description?: string | null; context?: unknown }): number[] {
  const found = new Set<number>();
  const text = `${f.title ?? ''}\n${f.description ?? ''}`;
  for (const m of text.matchAll(/(?:#|\/pull\/)(\d{1,9})(?!\d)/g)) found.add(Number(m[1]));
  const ctx = (f.context && typeof f.context === 'object' && !Array.isArray(f.context)) ? f.context as Record<string, unknown> : {};
  const raw = [ctx.prNumber, ...(Array.isArray(ctx.prNumbers) ? ctx.prNumbers : [])];
  for (const v of raw) if (Number.isInteger(v) && (v as number) > 0) found.add(v as number);
  return [...found].filter((n) => n > 0).sort((a, b) => a - b);
}
