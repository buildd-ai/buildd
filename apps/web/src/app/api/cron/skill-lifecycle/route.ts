// GET /api/cron/skill-lifecycle
//
// Skill retirement sweep (spec "Skill candidates, usage telemetry and
// retirement"). Reads claim telemetry (skill_usage), applies the pure rule in
// @buildd/core/skill-retirement-rule and writes skill_lifecycle_events.
//
// Recording mode (the default; SKILL_RETIREMENT_MODE unset or anything but
// "acting") only writes events: it never changes a skill. Acting mode disables
// an archivable skill (enabled=false, never a delete) and writes an audit row.
// Nothing is archivable until telemetry has run the full archive window.
//
// Auth: Bearer token matching CRON_SECRET. Recommended schedule: daily.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { DEFAULT_ROLES } from '@/lib/default-roles';
import {
  evaluateRetirement, resolveRetirementMode, type RetirementSkill,
} from '@buildd/core/skill-retirement-rule';
import { archiveSkill, type LifecycleEvent } from '@buildd/core/skill-lifecycle-events';

export const maxDuration = 60;

/** A skill is re-flagged at most once per this many days, so a daily sweep does not append a row per day. */
const REFLAG_AFTER_DAYS = 7;

type Row = Record<string, any>;
const rowsOf = (res: unknown): Row[] => ((res as { rows?: Row[] })?.rows ?? []) as Row[];

export async function GET(req: NextRequest) {
  return withCronRun('skill-lifecycle', req, report => run(report));
}

function templateSlugs(template: unknown): string[] {
  const t = (template ?? {}) as { skillSlugs?: unknown; context?: { skillSlugs?: unknown } };
  return [t.skillSlugs, t.context?.skillSlugs]
    .flatMap(v => (Array.isArray(v) ? v : []))
    .filter((v): v is string => typeof v === 'string');
}

async function run(report: CronReport): Promise<NextResponse> {
  const now = new Date();
  const mode = resolveRetirementMode(process.env.SKILL_RETIREMENT_MODE);

  const [skillRes, telemetryRes, scheduleRes, activeRes] = await Promise.all([
    db.execute(sql`
      SELECT s.id, s.team_id, s.slug, s.enabled, s.is_role, s.content, s.content_hash, s.created_at,
             COALESCE((s.metadata->>'pinned') = 'true', false) AS pinned,
             u.last_claimed_at,
             (SELECT max(e.created_at) FROM skill_lifecycle_events e
               WHERE e.skill_id = s.id AND e.action = 'restored') AS last_restored_at
      FROM workspace_skills s
      LEFT JOIN skill_usage u ON u.skill_id = s.id
      WHERE s.enabled = true`),
    db.execute(sql`SELECT min(first_claimed_at) AS started FROM skill_usage`),
    // Every schedule template counts, enabled or not: a paused schedule resumes.
    db.execute(sql`SELECT task_template FROM task_schedules`),
    db.execute(sql`
      SELECT DISTINCT jsonb_array_elements_text(context->'skillSlugs') AS slug
      FROM tasks
      WHERE status IN ('pending', 'assigned', 'in_progress')
        AND jsonb_typeof(context->'skillSlugs') = 'array'`),
  ]);

  const byId = new Map<string, Row>();
  const skills: RetirementSkill[] = rowsOf(skillRes).map(r => {
    byId.set(r.id, r);
    return {
      id: r.id, slug: r.slug, enabled: r.enabled, isRole: !!r.is_role, pinned: !!r.pinned,
      createdAt: new Date(r.created_at),
      lastClaimedAt: r.last_claimed_at ? new Date(r.last_claimed_at) : null,
      lastRestoredAt: r.last_restored_at ? new Date(r.last_restored_at) : null,
    };
  });

  // No claim has ever been counted: telemetry has not started, so it starts now.
  const started = rowsOf(telemetryRes)[0]?.started;
  const telemetryStartedAt = started ? new Date(started) : now;

  const verdict = evaluateRetirement({
    skills, now, telemetryStartedAt, mode,
    defaultRoleSlugs: DEFAULT_ROLES.map(r => r.slug),
    scheduleSkillSlugs: rowsOf(scheduleRes).flatMap(r => templateSlugs(r.task_template)),
    activeTaskSkillSlugs: rowsOf(activeRes).map(r => String(r.slug)),
  });

  const archivableIds = new Set(verdict.archivable.map(s => s.id));
  const events: LifecycleEvent[] = [];
  let archived = 0;

  for (const s of verdict.stale) {
    if (archivableIds.has(s.id)) continue;
    const r = byId.get(s.id)!;
    events.push({
      skillId: s.id, teamId: r.team_id, action: 'stale', mode, reason: 'unclaimed past the stale window',
      previousEnabled: true, previousContentHash: r.content_hash, createdAt: now,
    });
  }
  for (const s of verdict.archivable) {
    const r = byId.get(s.id)!;
    const row = { id: s.id, teamId: r.team_id, enabled: true, content: r.content, contentHash: r.content_hash };
    const out = archiveSkill(row, { mode, reason: 'unclaimed past the archive window', now });
    if (mode === 'acting') {
      const res = await db.execute(sql`
        UPDATE workspace_skills SET enabled = false, updated_at = now()
        WHERE id = ${s.id}::uuid AND enabled = true RETURNING id`);
      if (rowsOf(res).length === 0) continue;
      archived++;
    }
    events.push(out.event);
  }

  if (events.length > 0) {
    const values = sql.join(events.map(e => sql`(${e.skillId}::uuid, ${e.teamId}::uuid, ${e.action}, ${e.mode},
      ${e.reason}, ${e.previousEnabled}, ${e.previousContentHash}, ${e.createdAt.toISOString()}::timestamptz)`), sql`, `);
    // Archive rows are always new facts; stale / would_archive are throttled per skill and action.
    await db.execute(sql`
      INSERT INTO skill_lifecycle_events
        (skill_id, team_id, action, mode, reason, previous_enabled, previous_content_hash, created_at)
      SELECT v.* FROM (VALUES ${values}) AS v(skill_id, team_id, action, mode, reason, previous_enabled, previous_content_hash, created_at)
      WHERE v.action = 'archived' OR NOT EXISTS (
        SELECT 1 FROM skill_lifecycle_events e
        WHERE e.skill_id = v.skill_id AND e.action = v.action
          AND e.created_at > now() - make_interval(days => ${REFLAG_AFTER_DAYS}))`);
  }

  report({ processed: skills.length, changed: archived, result: { mode, stale: verdict.stale.length, archivable: verdict.archivable.length, archived } });
  return NextResponse.json({
    ok: true, mode, archived,
    stale: verdict.stale.length, archivable: verdict.archivable.length, report: verdict.report,
  });
}
