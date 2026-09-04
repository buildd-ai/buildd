#!/usr/bin/env bun
/**
 * Re-enable mission schedules that were auto-disabled by the budget_exhausted
 * ordering bug in the schedules cron.
 *
 * The bug: `budget_exhausted` fell through to `if (mission.status !== 'active')`,
 * which set `taskSchedules.enabled = false` instead of deferring. Raising
 * costBudgetUsd flips the mission back to `active` but never re-enables the
 * schedule (that only happens on an explicit status write), and the due-schedule
 * query reads `enabled = true AND nextRunAt <= now` — so the mission went
 * permanently silent. Fixed forward in PR #2080; this heals rows already stuck.
 *
 * Fingerprint (all five must hold):
 *   1. the mission has a system 'Budget exhausted' note — it really did exhaust
 *   2. the mission is `active` now — someone raised the budget
 *   3. its linked schedule has enabled = false
 *   4. the schedule is not one-shot (those self-disable by design)
 *   5. the disable landed at or after the exhaustion (see the rule module)
 *
 * A schedule a human disabled on a mission that never exhausted its budget does
 * not match, because of (1) and (5).
 *
 * Lives under packages/core/scripts/ because `drizzle-orm` resolves there;
 * root-level scripts/ cannot import it (scripts/backfill-seat-ids.ts has the
 * same latent problem).
 *
 * Reports only by default:
 *   bun run packages/core/scripts/heal-budget-disabled-schedules.ts
 *   bun run packages/core/scripts/heal-budget-disabled-schedules.ts --apply
 *   ... --apply --only <scheduleId>[,<scheduleId>...]
 *
 * Requires DATABASE_URL. Note .env / .env.local point at a stale Neon branch —
 * use `vercel env pull` for the production URL.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import { missionNotes, missions, taskSchedules } from '../db/schema';
import { disableIsConsistentWithBudgetBug, staggeredResumeAt } from './budget-schedule-heal-rule';

const APPLY = process.argv.includes('--apply');
const onlyArg = process.argv.indexOf('--only');
const ONLY: string[] | null =
  onlyArg !== -1 && process.argv[onlyArg + 1]
    ? process.argv[onlyArg + 1]!.split(',').map(s => s.trim()).filter(Boolean)
    : null;

async function main() {
  // Resolved inside main(), not at module scope: a top-level process.exit would
  // fire on mere import and abort any test run that touches this file.
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }
  const db = drizzle(neon(DATABASE_URL), { schema });

  // (1) missions that carry the system exhaustion note
  const exhaustionNotes = await db
    .select({ missionId: missionNotes.missionId, createdAt: missionNotes.createdAt })
    .from(missionNotes)
    .where(and(
      eq(missionNotes.authorType, 'system'),
      eq(missionNotes.title, 'Budget exhausted'),
    ));

  if (exhaustionNotes.length === 0) {
    console.log('No mission has ever recorded a "Budget exhausted" note — nothing to heal.');
    return;
  }

  // Most recent note per mission.
  const exhaustedAt = new Map<string, Date>();
  for (const note of exhaustionNotes) {
    if (!note.missionId || !note.createdAt) continue;
    const prev = exhaustedAt.get(note.missionId);
    if (!prev || note.createdAt > prev) exhaustedAt.set(note.missionId, note.createdAt);
  }

  // (2) of those, active again with a linked schedule
  const candidateMissions = await db
    .select({
      id: missions.id,
      title: missions.title,
      scheduleId: missions.scheduleId,
      costBudgetUsd: missions.costBudgetUsd,
    })
    .from(missions)
    .where(and(
      inArray(missions.id, [...exhaustedAt.keys()]),
      eq(missions.status, 'active'),
    ));

  const scheduleIds = candidateMissions
    .map(m => m.scheduleId)
    .filter((id): id is string => !!id);

  if (scheduleIds.length === 0) {
    console.log(
      `${exhaustedAt.size} mission(s) exhausted a budget at some point, but none is ` +
      `currently active with a linked schedule — nothing to heal.`,
    );
    return;
  }

  // (3)(4) disabled, not one-shot
  const rows = await db
    .select({
      id: taskSchedules.id,
      name: taskSchedules.name,
      cronExpression: taskSchedules.cronExpression,
      timezone: taskSchedules.timezone,
      nextRunAt: taskSchedules.nextRunAt,
      updatedAt: taskSchedules.updatedAt,
      lastDeferralReason: taskSchedules.lastDeferralReason,
    })
    .from(taskSchedules)
    .where(and(
      inArray(taskSchedules.id, scheduleIds),
      eq(taskSchedules.enabled, false),
      eq(taskSchedules.oneShot, false),
    ));

  const missionBySchedule = new Map(
    candidateMissions.filter(m => m.scheduleId).map(m => [m.scheduleId!, m]),
  );

  const affected = ONLY ? rows.filter(r => ONLY.includes(r.id)) : rows;

  if (affected.length === 0) {
    console.log(
      ONLY
        ? 'None of the --only ids matched the fingerprint. Nothing to heal.'
        : 'No schedule matches the fingerprint. Nothing to heal.',
    );
    return;
  }

  console.log(`${affected.length} schedule(s) match the fingerprint:\n`);
  const healable: typeof affected = [];
  for (const s of affected) {
    const m = missionBySchedule.get(s.id);
    const exhausted = m ? exhaustedAt.get(m.id) : undefined;
    const consistent = disableIsConsistentWithBudgetBug(s.updatedAt, exhausted);
    if (consistent) healable.push(s);

    console.log(`  schedule ${s.id}  "${s.name}"`);
    console.log(`    cron            ${s.cronExpression} (${s.timezone})`);
    console.log(`    mission         ${m?.id} "${m?.title}"  budget=$${m?.costBudgetUsd ?? 'null'}`);
    console.log(`    exhausted at    ${exhausted?.toISOString() ?? 'unknown'}`);
    console.log(`    disabled at     ${s.updatedAt?.toISOString() ?? 'unknown'}`);
    console.log(`    nextRunAt       ${s.nextRunAt?.toISOString() ?? 'null'}`);
    console.log(`    lastDeferral    ${s.lastDeferralReason ?? 'null'}`);
    if (!consistent) {
      console.log('    SKIP: disabled before the exhaustion note — not this bug, review by hand');
    }
    console.log('');
  }

  if (!APPLY) {
    console.log(`Dry run — nothing written. ${healable.length} of ${affected.length} would be re-enabled.`);
    console.log('Each re-enabled schedule resumes creating tasks, which spends budget.');
    console.log('Re-run with --apply to write.');
    return;
  }

  const skipped = affected.length - healable.length;
  if (skipped > 0) console.log(`Skipping ${skipped} row(s) whose disable predates the exhaustion note.\n`);

  const now = new Date();
  let healed = 0;
  for (const [i, s] of healable.entries()) {
    // Stagger the resumes. Every healed schedule is long overdue, so they would
    // all be due on the same tick; the pacing and workspace-cap gates would
    // absorb that, but spreading it keeps the resume legible in the logs.
    const nextRunAt = staggeredResumeAt(now, i);
    const [updated] = await db
      .update(taskSchedules)
      .set({ enabled: true, nextRunAt, lastDeferralReason: null, updatedAt: now })
      // Guard on enabled=false so a concurrent re-enable is not clobbered.
      .where(and(eq(taskSchedules.id, s.id), eq(taskSchedules.enabled, false)))
      .returning({ id: taskSchedules.id });

    if (!updated) {
      console.log(`  skipped ${s.id} — no longer disabled`);
      continue;
    }
    console.log(`  re-enabled ${s.id} — next run ${nextRunAt.toISOString()}`);
    healed++;
  }

  console.log(`\nDone. Re-enabled ${healed} schedule(s).`);
}

// Only run when invoked directly, so importing this file never opens a DB
// connection or exits the process.
if (import.meta.main) {
  main().catch(err => {
    console.error('FAILED:', err);
    process.exit(1);
  });
}
