/**
 * GET /api/cron/experiment-health
 *
 * Daily enrolment check over every running experiment on every team
 * (packages/core/experiment-health.ts): nothing enrolled for days, an arm that
 * was never drawn, a split far off the declared fraction, one unit (mission)
 * holding most of an arm, or running past its duration cap. Experiments used
 * to fail all of these silently; the readout only compares arms, so a starved
 * experiment looked like one that was merely "insufficient_n".
 *
 * Two effects, nothing else:
 * - An experiment past its cap (config.maxDurationDays / config.endsAt) is
 *   PAUSED, through the same guarded update the API uses, so the cap is a cap.
 *   Paused, not concluded: concluding needs a human decision. Tier pools are
 *   never paused here; they have no cap and are managed on their own page.
 * - One Pushover alert (the 'alerts' app, same path as the other health
 *   crons) listing every unhealthy experiment. Daily cadence is the dedupe: a
 *   finding nobody acts on repeats once a day, not hourly.
 *
 * `changed` = experiments with at least one finding (findings polarity).
 *
 * Auth: Bearer CRON_SECRET (via withCronRun).
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildRunningExperimentsQuery, runExperimentHealth } from '@buildd/core/experiment-health-source';
import type { ExperimentHealthFinding } from '@buildd/core/experiment-health';
import { applyExperimentUpdate } from '@/lib/experiments-store';
import { notify } from '@/lib/pushover';
import { withCronRun } from '@/lib/cron-run';

export const maxDuration = 60;

const EXPERIMENT_HEALTH_JOB = 'experiment-health';

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

/** Lines in the alert before it collapses into "+N more". */
const DIGEST_LINES = 8;

interface Unhealthy {
  id: string;
  key: string;
  kind: string;
  findings: ExperimentHealthFinding[];
  paused: boolean;
}

export async function GET(req: NextRequest) {
  return withCronRun(EXPERIMENT_HEALTH_JOB, req, async report => {
    const now = new Date();
    const rows = await buildRunningExperimentsQuery();
    const unhealthy: Unhealthy[] = [];
    let errors = 0;

    for (const row of rows) {
      let findings: ExperimentHealthFinding[];
      try {
        findings = await runExperimentHealth(row, now);
      } catch (err) {
        errors++;
        console.error(`[experiment-health] ${row.id} check failed:`, err);
        continue;
      }
      if (findings.length === 0) continue;

      let paused = false;
      if (row.kind !== 'tier_pool' && findings.some(f => f.code === 'past_duration_cap')) {
        try {
          const updated = await applyExperimentUpdate(
            row.teamId,
            row.id,
            { status: 'running', policyVersion: row.policyVersion },
            { status: 'paused', updatedAt: now },
            null,
          );
          paused = !!updated;
        } catch (err) {
          errors++;
          console.error(`[experiment-health] pausing ${row.id} past its cap failed:`, err);
        }
      }
      unhealthy.push({ id: row.id, key: row.key, kind: row.kind, findings, paused });
    }

    if (unhealthy.length > 0) {
      const lines = unhealthy.flatMap(u => u.findings.map(f => `• ${u.key}: ${f.code}: ${f.detail}${u.paused && f.code === 'past_duration_cap' ? ' (paused)' : ''}`));
      const shown = lines.slice(0, DIGEST_LINES);
      if (lines.length > DIGEST_LINES) shown.push(`• +${lines.length - DIGEST_LINES} more`);
      notify({
        app: 'alerts',
        title: unhealthy.length === 1
          ? `[buildd] Experiment unhealthy — ${unhealthy[0].key}`
          : `[buildd] ${unhealthy.length} experiments unhealthy`,
        message: shown.join('\n'),
        priority: 0,
        url: `${APP_BASE_URL}/app/health`,
        urlTitle: 'View experiments',
      });
    }

    const paused = unhealthy.filter(u => u.paused).map(u => u.id);
    console.log(JSON.stringify({ event: 'experiment_health', checked: rows.length, unhealthy: unhealthy.length, paused: paused.length, errors }));
    report({
      processed: rows.length,
      changed: unhealthy.length,
      errors,
      result: { unhealthy: unhealthy.length, paused: paused.length },
    });
    return NextResponse.json({ ok: true, checked: rows.length, unhealthy: unhealthy.length, paused, errors, experiments: unhealthy });
  });
}
