#!/usr/bin/env bun
/**
 * Re-check release rows that were failed for reasons that turned out false.
 *
 * Two bugs wrote wrong terminal states onto `releases`:
 *
 *  1. `workflow conclusion: skipped`. The workflow_run webhook's head-sha
 *     fallback matched ANY workflow on the release's sha — a sibling run that
 *     skipped (CI Auto-Fix, Sync-dev, …) failed the row, and the real release
 *     run's success arriving later was dropped by the terminal-state guard.
 *     This script looks up the row's actual release run (the configured
 *     workflow file, `workflow_dispatch`, same sha) and applies ITS verdict.
 *
 *  2. `… the release PR was never merged into the production branch`. The
 *     gated merge path compared the row's pre-dispatch sha to the release PR
 *     head by equality, which never matches, so the 24h sweep failed rows
 *     whose PR had merged. These rows are put back into `pending_external`;
 *     the next release-health-check tick re-examines them with the fixed
 *     logic and either heals them (a merged release PR contains the sha) or
 *     fails them with an accurate reason.
 *
 * Nothing is hardcoded: rows are selected by their failure reason. Every
 * write is compare-and-set on (id, state='failed', failure_reason unchanged).
 *
 * Run from the repo root:
 *   bun run scripts/repair-release-rows.ts            # dry run (default)
 *   bun run scripts/repair-release-rows.ts --apply    # write
 *
 * Requires DATABASE_URL. Case 1 also needs GITHUB_TOKEN with actions:read on
 * the affected repos; without it those rows are reported and left alone.
 */

export const SKIPPED_REASON = 'workflow conclusion: skipped';
export const FALSE_NEVER_MERGED_SUFFIX = 'the release PR was never merged into the production branch';

export interface RepairRow {
  id: string;
  archetype: string;
  failureReason: string | null;
  headSha: string | null;
  runUrl: string | null;
  workflowFile: string | null;
  repoFullName: string | null;
}

export type RealRun = { conclusion: string | null; htmlUrl: string } | null | 'unknown';

export type RepairPlan =
  | { kind: 'skip'; why: string }
  | { kind: 'update'; set: Record<string, unknown>; why: string };

export function needsRunLookup(row: RepairRow): boolean {
  return row.failureReason === SKIPPED_REASON;
}

export function planRepair(row: RepairRow, realRun: RealRun, now: Date = new Date()): RepairPlan {
  if (row.failureReason === SKIPPED_REASON) {
    if (realRun === 'unknown') return { kind: 'skip', why: 'could not look up the release run' };
    if (!realRun) return { kind: 'skip', why: 'no release workflow_dispatch run found for this sha' };
    if (realRun.conclusion === null || realRun.conclusion === 'action_required') {
      return { kind: 'skip', why: 'release run has not concluded' };
    }
    if (realRun.conclusion === 'skipped') return { kind: 'skip', why: 'the release run itself skipped — the row is right' };
    if (realRun.conclusion === 'success') {
      // Same states the webhook would have written for this run.
      return row.archetype === 'gated'
        ? {
            kind: 'update',
            set: { state: 'pending_external', failureReason: null, runUrl: realRun.htmlUrl },
            why: 'release run succeeded; gated row waits for the cron to find its merged release PR',
          }
        : {
            kind: 'update',
            set: { state: 'deploying', deployedAt: now, failureReason: null, runUrl: realRun.htmlUrl },
            why: 'release run succeeded; row re-enters verification',
          };
    }
    return {
      kind: 'update',
      set: { failureReason: `workflow conclusion: ${realRun.conclusion}`, runUrl: realRun.htmlUrl },
      why: `release run concluded ${realRun.conclusion}; record the real reason`,
    };
  }

  if (row.failureReason?.endsWith(FALSE_NEVER_MERGED_SUFFIX)) {
    if (row.archetype !== 'gated') return { kind: 'skip', why: 'not a gated row' };
    if (!row.headSha) return { kind: 'skip', why: 'row has no head sha to look for' };
    return {
      kind: 'update',
      set: { state: 'pending_external', failureReason: null },
      why: 'unverified "never merged"; the cron re-checks it against merged release PRs',
    };
  }

  return { kind: 'skip', why: 'not a repairable failure reason' };
}

async function lookupRealRun(row: RepairRow, token: string | undefined): Promise<RealRun> {
  if (!token || !row.repoFullName || !row.workflowFile || !row.headSha) return 'unknown';
  const file = row.workflowFile.replace(/^(\.\/)?(\.github\/workflows\/)?/, '');
  const url =
    `https://api.github.com/repos/${row.repoFullName}/actions/workflows/${encodeURIComponent(file)}/runs` +
    `?event=workflow_dispatch&head_sha=${encodeURIComponent(row.headSha)}&per_page=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) return 'unknown';
  const data = (await res.json()) as { workflow_runs?: Array<{ conclusion: string | null; html_url: string; created_at: string }> };
  const runs = (data.workflow_runs ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = runs[0];
  return latest ? { conclusion: latest.conclusion, htmlUrl: latest.html_url } : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set');
    process.exit(1);
  }
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  const { and, eq, or, like } = await import('drizzle-orm');
  const schema = await import('../packages/core/db/schema');
  const db = drizzle(neon(DATABASE_URL), { schema });
  const { releases, workspaces, githubRepos } = schema;

  const rows = await db
    .select({
      id: releases.id,
      archetype: releases.archetype,
      failureReason: releases.failureReason,
      headSha: releases.headSha,
      runUrl: releases.runUrl,
      releaseConfig: workspaces.releaseConfig,
      repoFullName: githubRepos.fullName,
    })
    .from(releases)
    .innerJoin(workspaces, eq(releases.workspaceId, workspaces.id))
    .leftJoin(githubRepos, eq(workspaces.githubRepoId, githubRepos.id))
    .where(
      and(
        eq(releases.state, 'failed'),
        or(eq(releases.failureReason, SKIPPED_REASON), like(releases.failureReason, `%${FALSE_NEVER_MERGED_SUFFIX}`)),
      ),
    );

  console.log(`[repair-release-rows] mode=${apply ? 'apply' : 'dry-run'} candidates=${rows.length}`);
  const token = process.env.GITHUB_TOKEN;
  let updated = 0;

  for (const r of rows) {
    const row: RepairRow = {
      id: r.id,
      archetype: r.archetype,
      failureReason: r.failureReason,
      headSha: r.headSha,
      runUrl: r.runUrl,
      workflowFile: r.releaseConfig?.workflowFile ?? null,
      repoFullName: r.repoFullName ?? null,
    };
    const realRun = needsRunLookup(row) ? await lookupRealRun(row, token) : null;
    const plan = planRepair(row, realRun);
    console.log(`  ${row.id.slice(0, 8)}  ${plan.kind.padEnd(6)}  ${plan.why}`);
    if (plan.kind !== 'update' || !apply) continue;

    const done = await db
      .update(releases)
      .set(plan.set)
      .where(and(eq(releases.id, row.id), eq(releases.state, 'failed'), eq(releases.failureReason, row.failureReason!)))
      .returning({ id: releases.id });
    if (done.length > 0) updated++;
  }

  console.log(`[repair-release-rows] ${apply ? `updated=${updated}` : 'dry run — pass --apply to write'}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
