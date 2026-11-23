// GET /api/cron/skill-lifecycle
//
// Skill retirement sweep (spec "Skill candidates, usage telemetry and
// retirement"). Reads claim telemetry (skill_usage), applies the pure rule in
// @buildd/core/skill-retirement-rule and writes skill_lifecycle_events.
//
// Mode is per workspace (gitConfig.skillRetirement.mode: off | recording | acting;
// unrecognised or absent = recording). "off" skips the workspace. Recording only
// writes events. Acting disables an archivable skill (enabled=false, never a
// delete) and writes an audit row, but only for workspaces on the platform
// owner's SKILL_RETIREMENT_ACTING_WORKSPACES allowlist and only once telemetry
// has run the full archive window; otherwise it is refused, recorded as
// recording, and listed under "refusals" in the response.
//
// Auth: Bearer token matching CRON_SECRET. Recommended schedule: daily.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { DEFAULT_ROLES } from '@/lib/default-roles';
import {
  evaluateRetirement, resolveRetirementMode, gateActingMode, parseActingAllowlist,
  DEFAULT_ARCHIVE_DAYS, type RetirementSkill,
} from '@buildd/core/skill-retirement-rule';
import { archiveSkill, type LifecycleEvent } from '@buildd/core/skill-lifecycle-events';
import { proposeLinkRetirements } from '@buildd/core/skill-spec-links';

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
  const allowlist = parseActingAllowlist(process.env.SKILL_RETIREMENT_ACTING_WORKSPACES);

  const [skillRes, telemetryRes, scheduleRes, activeRes] = await Promise.all([
    db.execute(sql`
      SELECT s.id, s.team_id, s.workspace_id, w.git_config, s.slug, s.enabled, s.is_role, s.content, s.content_hash, s.created_at,
             COALESCE((s.metadata->>'pinned') = 'true', false) AS pinned,
             u.last_claimed_at,
             (SELECT max(e.created_at) FROM skill_lifecycle_events e
               WHERE e.skill_id = s.id AND e.action = 'restored') AS last_restored_at
      FROM workspace_skills s
      LEFT JOIN skill_usage u ON u.skill_id = s.id
      LEFT JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.enabled = true`),
    db.execute(sql`SELECT team_id, min(telemetry_started_at) AS started FROM skill_usage GROUP BY team_id`),
    // Every schedule template counts, enabled or not: a paused schedule resumes.
    db.execute(sql`SELECT task_template FROM task_schedules`),
    db.execute(sql`
      SELECT DISTINCT jsonb_array_elements_text(context->'skillSlugs') AS slug
      FROM tasks
      WHERE status IN ('pending', 'assigned', 'in_progress')
        AND jsonb_typeof(context->'skillSlugs') = 'array'`),
  ]);

  // Telemetry start is per team: a team with no counted claim has not started, so it starts now.
  const startedByTeam = new Map<string, Date>();
  for (const r of rowsOf(telemetryRes)) if (r.started) startedByTeam.set(String(r.team_id), new Date(r.started));
  const startOf = (teamId: string) => startedByTeam.get(teamId) ?? now;

  const byId = new Map<string, Row>();
  const modeOf = new Map<string, 'recording' | 'acting'>();
  const refusals: Array<{ workspaceId: string | null; refusal: string; telemetryDays: number; archiveDays: number }> = [];
  const refused = new Set<string>();
  const skills: Array<RetirementSkill & { teamId: string }> = rowsOf(skillRes).flatMap(r => {
    const requested = resolveRetirementMode(r.git_config);
    if (requested === 'off') return [];
    const telemetryStartedAt = startOf(String(r.team_id));
    const telemetryDays = Math.floor((now.getTime() - telemetryStartedAt.getTime()) / 86_400_000);
    const d = gateActingMode(requested, { workspaceId: r.workspace_id ?? null, allowlist, now, telemetryStartedAt });
    modeOf.set(r.id, d.mode as 'recording' | 'acting');
    if (d.refusal) {
      const key = `${r.workspace_id}:${d.refusal}`;
      if (!refused.has(key)) {
        refused.add(key);
        refusals.push({ workspaceId: r.workspace_id ?? null, refusal: d.refusal, telemetryDays, archiveDays: DEFAULT_ARCHIVE_DAYS });
      }
    }
    return [r];
  }).map(r => {
    byId.set(r.id, r);
    return {
      id: r.id, teamId: String(r.team_id), slug: r.slug, enabled: r.enabled, isRole: !!r.is_role, pinned: !!r.pinned,
      createdAt: new Date(r.created_at),
      lastClaimedAt: r.last_claimed_at ? new Date(r.last_claimed_at) : null,
      lastRestoredAt: r.last_restored_at ? new Date(r.last_restored_at) : null,
    };
  });

  // The rule takes one telemetry start, so evaluate each team on its own clock.
  const scheduleSkillSlugs = rowsOf(scheduleRes).flatMap(r => templateSlugs(r.task_template));
  const activeTaskSkillSlugs = rowsOf(activeRes).map(r => String(r.slug));
  const teamIds = [...new Set(skills.map(s => s.teamId))];
  const verdicts = teamIds.map(teamId => evaluateRetirement({
    skills: skills.filter(s => s.teamId === teamId), now, telemetryStartedAt: startOf(teamId),
    defaultRoleSlugs: DEFAULT_ROLES.map(r => r.slug), scheduleSkillSlugs, activeTaskSkillSlugs,
  }));
  const verdict = {
    stale: verdicts.flatMap(v => v.stale),
    archivable: verdicts.flatMap(v => v.archivable),
    report: verdicts.map(v => v.report).join('; '),
  };

  const archivableIds = new Set(verdict.archivable.map(s => s.id));
  const events: LifecycleEvent[] = [];
  let archived = 0;

  for (const s of verdict.stale) {
    if (archivableIds.has(s.id)) continue;
    const r = byId.get(s.id)!;
    const mode = modeOf.get(s.id)!;
    events.push({
      skillId: s.id, teamId: r.team_id, action: 'stale', mode, reason: 'unclaimed past the stale window',
      previousEnabled: true, previousContentHash: r.content_hash, createdAt: now,
    });
  }
  for (const s of verdict.archivable) {
    const r = byId.get(s.id)!;
    const mode = modeOf.get(s.id)!;
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

  // Confirmed links to a retired/superseded spec: a proposal for a person, in either
  // mode. It never disables; a similarity or path score is not an input here.
  const linkRes = await db.execute(sql`
    SELECT l.skill_id, l.spec_id, sp.status AS spec_status
    FROM skill_spec_links l JOIN specs sp ON sp.id = l.spec_id
    WHERE sp.status IN ('retired', 'superseded')`);
  const linkRows = rowsOf(linkRes);
  if (linkRows.length > 0) {
    const live = rowsOf(await db.execute(sql`
      SELECT id, team_id, enabled, content_hash FROM workspace_skills WHERE enabled = true`));
    events.push(...proposeLinkRetirements({
      links: linkRows.map(r => ({ skillId: String(r.skill_id), specId: String(r.spec_id) })),
      specs: linkRows.map(r => ({ id: String(r.spec_id), status: String(r.spec_status) })),
      skills: live.map(r => ({ id: String(r.id), teamId: String(r.team_id), enabled: !!r.enabled, contentHash: String(r.content_hash) })),
      now,
    }));
  }

  if (events.length > 0) {
    const values = sql.join(events.map(e => sql`(${e.skillId}::uuid, ${e.teamId}::uuid, ${e.action}, ${e.mode},
      ${e.reason}, ${e.previousEnabled}, ${e.previousContentHash}, ${e.createdAt.toISOString()}::timestamptz)`), sql`, `);
    // Archive rows are always new facts; stale / would_archive / retirement_proposed are throttled per skill and action.
    await db.execute(sql`
      INSERT INTO skill_lifecycle_events
        (skill_id, team_id, action, mode, reason, previous_enabled, previous_content_hash, created_at)
      SELECT v.* FROM (VALUES ${values}) AS v(skill_id, team_id, action, mode, reason, previous_enabled, previous_content_hash, created_at)
      WHERE v.action = 'archived' OR NOT EXISTS (
        SELECT 1 FROM skill_lifecycle_events e
        WHERE e.skill_id = v.skill_id AND e.action = v.action
          AND e.created_at > now() - make_interval(days => ${REFLAG_AFTER_DAYS}))`);
  }

  report({ processed: skills.length, changed: archived, result: { refusals: refusals.length, stale: verdict.stale.length, archivable: verdict.archivable.length, archived } });
  return NextResponse.json({
    ok: true, archived, refusals,
    stale: verdict.stale.length, archivable: verdict.archivable.length, report: verdict.report,
  });
}
