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
 * "Deliverable" mirrors what `attachSkillBundles` will do for WHICHEVER
 * account claims: an enabled row scoped to this workspace, or an enabled
 * account-level row present on EVERY account that can claim here (the claim
 * falls back only to the claiming account's own rows, so a row on some of
 * them is a coin-toss drop). Team-level skill rows (workspaceId NULL, e.g.
 * created via /api/roles) are listed by `list_skills` as registered, but the
 * claim never delivers them as skill bundles — they are read here only to
 * name that cause in the error, never to pass the check.
 *
 * Not covered: a bundle the claim does attach but the runner then fails to
 * materialise in the worktree. That happens after dispatch and is invisible
 * from here.
 */
import { db } from '@buildd/core/db';
import { accountWorkspaces, tasks, workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm';

/** Why a required slug cannot be delivered by a claim in this workspace. */
export type MissingSkillReason = 'not_registered' | 'team_level_only' | 'not_on_every_claim_account';

export interface MissingSkill {
  slug: string;
  reason: MissingSkillReason;
}

const REASON_TEXT: Record<MissingSkillReason, string> = {
  not_registered: 'no enabled row in this workspace',
  team_level_only:
    'registered at team level only — claims deliver workspace-scoped skills, not team-level rows',
  not_on_every_claim_account:
    'an account-level row exists on some, but not all, of the accounts that can claim here',
};

export class MissingScheduleSkillError extends Error {
  readonly missingSlugs: string[];
  readonly missing: MissingSkill[];
  /** The workspace the check ran against (a mission schedule may have none of its own). */
  readonly workspaceId: string | null;
  constructor(missing: MissingSkill[] | string[], workspaceId: string | null = null) {
    const detailed: MissingSkill[] = missing.map(m =>
      typeof m === 'string' ? { slug: m, reason: 'not_registered' as const } : m,
    );
    super(
      `Required skill(s) not available to this workspace: ` +
      detailed.map(m => `${m.slug} (${REASON_TEXT[m.reason]})`).join('; ') + '. ' +
      `Register them in the schedule's workspace (register_skill) or remove them from the ` +
      `schedule's skillSlugs — no task was created.`,
    );
    this.name = 'MissingScheduleSkillError';
    this.missing = detailed;
    this.missingSlugs = detailed.map(m => m.slug);
    this.workspaceId = workspaceId;
  }
}

/** The skill slugs a schedule template requires (`context.skillSlugs`). */
export function requiredScheduleSkillSlugs(context: Record<string, unknown> | null | undefined): string[] {
  const raw = context?.skillSlugs;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0))];
}

/** Each slug in `slugs` that no claim in `workspaceId` is guaranteed to deliver, with the reason. */
export async function diagnoseScheduleSkills(workspaceId: string, slugs: string[]): Promise<MissingSkill[]> {
  if (slugs.length === 0) return [];

  const [claimLinks, workspace] = await Promise.all([
    db.query.accountWorkspaces.findMany({
      where: and(eq(accountWorkspaces.workspaceId, workspaceId), eq(accountWorkspaces.canClaim, true)),
      columns: { accountId: true },
    }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } }),
  ]);
  const accountIds = [...new Set(claimLinks.map(l => l.accountId).filter(Boolean))];

  const scopes = [eq(workspaceSkills.workspaceId, workspaceId)];
  if (accountIds.length > 0) scopes.push(inArray(workspaceSkills.accountId, accountIds));
  // Team-level rows: read only to explain a miss (see the module header).
  if (workspace?.teamId) {
    scopes.push(and(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.teamId, workspace.teamId))!);
  }

  const rows = await db.query.workspaceSkills.findMany({
    where: and(
      inArray(workspaceSkills.slug, slugs),
      eq(workspaceSkills.enabled, true),
      scopes.length === 1 ? scopes[0] : or(...scopes),
    ),
    columns: { slug: true, workspaceId: true, accountId: true },
  });

  const missing: MissingSkill[] = [];
  for (const slug of slugs) {
    const forSlug = rows.filter(r => r.slug === slug);
    if (forSlug.some(r => r.workspaceId === workspaceId)) continue;
    const onAccounts = new Set(forSlug.map(r => r.accountId).filter(Boolean));
    if (accountIds.length > 0 && accountIds.every(a => onAccounts.has(a))) continue;
    if (onAccounts.size > 0 && accountIds.some(a => onAccounts.has(a))) {
      missing.push({ slug, reason: 'not_on_every_claim_account' });
    } else if (forSlug.some(r => r.workspaceId === null && !r.accountId)) {
      missing.push({ slug, reason: 'team_level_only' });
    } else {
      missing.push({ slug, reason: 'not_registered' });
    }
  }
  return missing;
}

/** Slugs from `slugs` that no claim in `workspaceId` is guaranteed to deliver. */
export async function findMissingScheduleSkills(workspaceId: string, slugs: string[]): Promise<string[]> {
  return (await diagnoseScheduleSkills(workspaceId, slugs)).map(m => m.slug);
}

/** Throws `MissingScheduleSkillError` when a required skill cannot be delivered. */
export async function assertScheduleSkillsAvailable(
  workspaceId: string,
  context: Record<string, unknown> | null | undefined,
): Promise<void> {
  const missing = await diagnoseScheduleSkills(workspaceId, requiredScheduleSkillSlugs(context));
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
      // Not 'schedule': this is system-filed friction with no scheduleId
      // column, and must not be counted as schedule-spawned work. Matches the
      // other system-generated reports (health-watcher, ci-retry).
      creationSource: 'webhook',
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
