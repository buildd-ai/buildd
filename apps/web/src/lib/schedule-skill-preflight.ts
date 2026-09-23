/**
 * Schedule pre-flight: a schedule whose template names `skillSlugs` must not
 * create a task when one of those skills cannot be delivered.
 *
 * The runner is told "You MUST use the <slug> skill" for every slug in
 * `task.context.skillSlugs`, but it only receives the bundles the claim route
 * resolves (`attachSkillBundles`). A slug that resolves to nothing produced a
 * worker told to use a skill that is not in its worktree — every run, on every
 * cadence tick, with nothing on the schedule saying why.
 *
 * This module fails that tick before a task exists: the cron's per-schedule
 * catch records the reason in `lastError`, counts it toward
 * `pauseAfterFailures`, and files ONE `[friction]` task (deduped by signature
 * for as long as it stays open).
 *
 * "Deliverable" mirrors the claim-time resolution exactly — an enabled row
 * scoped to this workspace, or an enabled account-level row belonging to an
 * account that can claim in this workspace. Anything looser would pass the
 * preflight for a skill the claim then drops.
 */
import { db } from '@buildd/core/db';
import { accountWorkspaces, tasks, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';

export class MissingScheduleSkillError extends Error {
  readonly missingSlugs: string[];
  /** The workspace the check ran against (a mission schedule may have none of its own). */
  readonly workspaceId: string | null;
  constructor(missingSlugs: string[], workspaceId: string | null = null) {
    super(
      `Required skill(s) not available to this workspace: ${missingSlugs.join(', ')}. ` +
      `Register them in the schedule's workspace (register_skill) or remove them from the ` +
      `schedule's skillSlugs — no task was created.`,
    );
    this.name = 'MissingScheduleSkillError';
    this.missingSlugs = missingSlugs;
    this.workspaceId = workspaceId;
  }
}

/** The skill slugs a schedule template requires (`context.skillSlugs`). */
export function requiredScheduleSkillSlugs(context: Record<string, unknown> | null | undefined): string[] {
  const raw = context?.skillSlugs;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0))];
}

/** Slugs from `slugs` that no claim in `workspaceId` could deliver a bundle for. */
export async function findMissingScheduleSkills(workspaceId: string, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return [];

  const claimLinks = await db.query.accountWorkspaces.findMany({
    where: and(eq(accountWorkspaces.workspaceId, workspaceId), eq(accountWorkspaces.canClaim, true)),
    columns: { accountId: true },
  });
  const accountIds = [...new Set(claimLinks.map(l => l.accountId).filter(Boolean))];

  const scope = accountIds.length > 0
    ? or(eq(workspaceSkills.workspaceId, workspaceId), inArray(workspaceSkills.accountId, accountIds))
    : eq(workspaceSkills.workspaceId, workspaceId);

  const rows = await db.query.workspaceSkills.findMany({
    where: and(inArray(workspaceSkills.slug, slugs), eq(workspaceSkills.enabled, true), scope),
    columns: { slug: true },
  });
  const found = new Set(rows.map(r => r.slug));
  return slugs.filter(s => !found.has(s));
}

/** Throws `MissingScheduleSkillError` when a required skill cannot be delivered. */
export async function assertScheduleSkillsAvailable(
  workspaceId: string,
  context: Record<string, unknown> | null | undefined,
): Promise<void> {
  const missing = await findMissingScheduleSkills(workspaceId, requiredScheduleSkillSlugs(context));
  if (missing.length > 0) throw new MissingScheduleSkillError(missing, workspaceId);
}

/** One open friction report per schedule, whichever slugs are missing. */
export function missingSkillFrictionSignature(scheduleId: string): string {
  return `schedule-missing-skill:${scheduleId}`;
}

const CLOSED_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * File the friction report for a schedule blocked on a missing skill — once.
 * While a report with this schedule's signature is open, later ticks file
 * nothing: the schedule's own `lastError` / `consecutiveFailures` already
 * carry the recurrence, and `pauseAfterFailures` stops it.
 */
export async function fileMissingSkillFriction(input: {
  scheduleId: string;
  scheduleName: string;
  workspaceId: string;
  missingSlugs: string[];
}): Promise<'created' | 'exists'> {
  const signature = missingSkillFrictionSignature(input.scheduleId);

  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, input.workspaceId),
      like(tasks.title, '[friction] %'),
      sql`${tasks.context}->>'frictionSignature' = ${signature}`,
      notInArray(tasks.status, CLOSED_TASK_STATUSES),
    ),
    columns: { id: true },
  });
  if (existing) return 'exists';

  const slugs = input.missingSlugs.join(', ');
  await db
    .insert(tasks)
    .values({
      workspaceId: input.workspaceId,
      title: `[friction] Schedule "${input.scheduleName}" requires missing skill(s): ${slugs}`.slice(0, 200),
      description: [
        `The schedule \`${input.scheduleName}\` (${input.scheduleId}) names skill(s) in its template's`,
        `\`skillSlugs\` that no claim in this workspace can deliver: ${slugs}.`,
        '',
        'The cron pre-flight now refuses to create a task for it, so each tick records a failure',
        'on the schedule instead of dispatching a worker that is told to use a skill it does not have.',
        'The schedule auto-pauses after its `pauseAfterFailures` limit.',
        '',
        '**Remedy**: register the skill in this workspace (`register_skill`), re-enable a disabled',
        "row, or remove the slug from the schedule's `skillSlugs`.",
      ].join('\n'),
      priority: 3,
      status: 'pending',
      mode: 'execution',
      taskClass: 'work',
      creationSource: 'schedule',
      category: 'bug',
      context: {
        frictionSignature: signature,
        frictionExcerpt: `missing skill(s): ${slugs}`,
        scheduleId: input.scheduleId,
        missingSkillSlugs: input.missingSlugs,
      },
    })
    .returning({ id: tasks.id });
  return 'created';
}
