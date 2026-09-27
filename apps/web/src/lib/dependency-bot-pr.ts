/**
 * Dependency-bot PRs (Renovate, Dependabot) belong to the bot, not to buildd.
 *
 * The bot owns the branch's whole lifecycle: it rebases, force-pushes, closes
 * superseded bumps and (often) automerges. The moment another author commits to
 * the branch it stops — Renovate posts "Edited/Blocked" and will not rebase
 * again — so a single buildd push (a CI fix, a conflict retry, even GitHub's
 * update-branch run on buildd's behalf) takes the PR away from the one actor
 * that was going to land it.
 *
 * So:
 *   - automatic adoption (webhook paths) skips these PRs entirely;
 *   - an explicit `request_pr_review` still adopts and reviews — explicit
 *     intent wins — but every path that would push to the branch refuses;
 *   - Home does not list them: they are neither buildd's work in flight nor a
 *     merge buildd is waiting on a human for.
 *
 * The rule is `type === 'Bot'` AND login in a fixed set, not "any bot". Other
 * bots open PRs buildd genuinely should adopt — `buildd-ai[bot]` opens release
 * PRs via `workflow_dispatch`, and the CI-retry webhook exists to fix exactly
 * those. The `[bot]` login suffix is reserved for GitHub Apps, so the login
 * alone is not forgeable by a user account; `type` is checked too when present
 * because it costs nothing and rules out any doubt.
 */

import { sql, type SQL } from 'drizzle-orm';
import { workers } from '@buildd/core/db/schema';

export const DEPENDENCY_BOT_LOGINS: ReadonlySet<string> = new Set([
  'renovate[bot]',
  'dependabot[bot]',
]);

/** The `user` object of a GitHub pull request (REST shape). */
export interface PrAuthor {
  login?: string | null;
  type?: string | null;
}

/**
 * True when a PR's author is a dependency bot.
 *
 * `type` is optional because not every caller has it (a stored login from an
 * older adoption does not); when it IS present it must say `Bot`.
 */
export function isDependencyBotAuthor(user: PrAuthor | null | undefined): boolean {
  const login = user?.login?.toLowerCase();
  if (!login || !DEPENDENCY_BOT_LOGINS.has(login)) return false;
  if (user?.type != null && user.type !== 'Bot') return false;
  return true;
}

/**
 * True when a task is the adoption bookkeeping row for a dependency-bot PR —
 * reads the `context.adoptedPr` stamp `resolveOrAdoptPrOwner` writes.
 *
 * This is the defence-in-depth check for push paths: whatever adopted the PR,
 * the task that owns it says whose branch it is.
 */
export function isDependencyBotPrContext(context: unknown): boolean {
  if (!context || typeof context !== 'object') return false;
  const adopted = (context as Record<string, unknown>).adoptedPr;
  if (!adopted || typeof adopted !== 'object') return false;
  const { author, authorType } = adopted as { author?: unknown; authorType?: unknown };
  return isDependencyBotAuthor({
    login: typeof author === 'string' ? author : null,
    type: typeof authorType === 'string' ? authorType : null,
  });
}

/** Why a push was refused — one sentence, reused in logs, gate rows and API errors. */
export function dependencyBotPushRefusal(prNumber: number): string {
  return `PR #${prNumber} is owned by a dependency bot — buildd does not push to its branch (the bot rebases it itself)`;
}

/**
 * SQL twin of {@link isDependencyBotPrContext} for a `workers` query: true
 * unless the worker's task is the adoption row of a dependency-bot PR.
 *
 * Matches on the stored login alone — older adoptions carry no `authorType`,
 * and the `[bot]` suffix is reserved for GitHub Apps, so a login in the set
 * cannot belong to a user account.
 */
export function workerNotDependencyBotPr(): SQL {
  const logins = sql.join([...DEPENDENCY_BOT_LOGINS].map((l) => sql`${l}`), sql`, `);
  return sql`not exists (select 1 from "tasks" "bot_pr_task" where "bot_pr_task"."id" = ${workers.taskId} and lower("bot_pr_task"."context"->'adoptedPr'->>'author') in (${logins}))`;
}
