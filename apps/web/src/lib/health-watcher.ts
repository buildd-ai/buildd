import { db } from '@buildd/core/db';
import {
  watchedProjects,
  watcherEvents,
  workspaces,
  workspaceSkills,
  tasks,
  githubInstallations,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { githubApi } from '@/lib/github';
import { dispatchNewTask } from '@/lib/task-dispatch';
import { notify } from '@/lib/pushover';
import { createHash, randomUUID } from 'crypto';
import { listProdDeployments, evaluateDeploymentHealth, type DeploymentHealth } from '@/lib/health-watcher-vercel';

type WatchedProject = typeof watchedProjects.$inferSelect;

const ACTIVE_TASK_STATUSES = ['pending', 'assigned', 'in_progress', 'review'];

export interface RunResult {
  checked: number;
  fired: number;
  errors: number;
  skipped: number;
}

const DEFAULT_INTERVAL_MIN = 60;

/**
 * Iterate enabled rows whose lastCheckedAt is older than DEFAULT_INTERVAL_MIN
 * (or null), run each signal check, update lastCheckedAt. Errors per project
 * are isolated — one bad row doesn't break the loop. Safe to call from a
 * fast-cadence cron (e.g. every minute) — the lastCheckedAt gate keeps GH
 * traffic to ~1/hour per row.
 */
export async function runHealthWatcher(opts?: { force?: boolean }): Promise<RunResult> {
  const cutoff = new Date(Date.now() - DEFAULT_INTERVAL_MIN * 60_000);
  const dueCondition = opts?.force
    ? eq(watchedProjects.enabled, true)
    : and(
        eq(watchedProjects.enabled, true),
        or(isNull(watchedProjects.lastCheckedAt), lt(watchedProjects.lastCheckedAt, cutoff)),
      );

  const projects = await db.select().from(watchedProjects).where(dueCondition);

  const result: RunResult = { checked: 0, fired: 0, errors: 0, skipped: 0 };

  for (const project of projects) {
    result.checked++;
    try {
      const firedPrs = await checkFailingReleasePRs(project);
      const firedProd = await checkProdReleaseHealth(project);
      result.fired += firedPrs + firedProd;
      await db
        .update(watchedProjects)
        .set({ lastCheckedAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(watchedProjects.id, project.id));
    } catch (err) {
      result.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[health-watcher] ${project.repo} failed:`, message);
      await db
        .update(watchedProjects)
        .set({ lastCheckedAt: new Date(), lastError: message, updatedAt: new Date() })
        .where(eq(watchedProjects.id, project.id));
    }
  }

  return result;
}

interface CheckRunSummary {
  name: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

interface OpenPR {
  number: number;
  title: string;
  htmlUrl: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  updatedAt: string;
}

async function checkFailingReleasePRs(project: WatchedProject): Promise<number> {
  const installationId = await resolveInstallationId(project.repo);
  if (!installationId) {
    throw new Error(`No GitHub installation found for ${project.repo}`);
  }

  const filter = project.releasePrFilter ?? {};
  const baseRef = filter.base ?? 'main';
  const [owner, name] = project.repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo: ${project.repo}`);

  const prs = await listOpenPRs(installationId, owner, name, baseRef);
  const candidates = prs.filter((pr) => matchesFilter(pr, filter));

  let fired = 0;
  for (const pr of candidates) {
    const failing = await failingChecksFor(installationId, owner, name, pr.headSha);
    if (failing.length === 0) continue;

    if (await isPrSuppressed(project, pr)) continue;

    const dedupeKey = dedupeKeyForPr(pr.number, pr.headSha);
    const created = await firePrAlert(project, pr, failing, dedupeKey);
    if (created) fired++;
  }
  return fired;
}

async function checkProdReleaseHealth(project: WatchedProject): Promise<number> {
  if (!project.vercelProjectId) return 0;
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) {
    throw new Error('VERCEL_API_TOKEN not configured');
  }

  const deployments = await listProdDeployments(project.vercelProjectId, token, {
    teamId: process.env.VERCEL_TEAM_ID || undefined,
  });
  const health = evaluateDeploymentHealth(deployments, { graceMin: project.prodGraceMin, now: Date.now() });
  if (health.status !== 'unhealthy' && health.status !== 'stale') return 0;
  if (await isProdSuppressed(project)) return 0;

  const created = await fireProdAlert(project, health);
  return created ? 1 : 0;
}

async function isProdSuppressed(project: WatchedProject): Promise<boolean> {
  // Any active buildd task on this project for the prod-health signal counts as
  // in-flight. (We don't gate on recent commits to main here — Vercel itself
  // reflects post-commit state, so a fresh commit means a fresh deploy attempt
  // we'll observe directly via the deploy list.)
  const active = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, project.workspaceId),
        inArray(tasks.status, ACTIVE_TASK_STATUSES),
        sql`${tasks.context}->>'watchedProjectId' = ${project.id}`,
        sql`${tasks.context}->>'watcherKind' = 'prod_unhealthy'`,
      ),
    )
    .limit(1);
  return active.length > 0;
}

async function fireProdAlert(project: WatchedProject, health: DeploymentHealth): Promise<boolean> {
  if (health.status === 'healthy' || health.status === 'unknown' || !health.dedupeKey || !health.deployment) {
    return false;
  }
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, project.workspaceId),
  });
  if (!workspace) return false;

  await ensureOpsRole(project.workspaceId, project.roleSlug);

  const dep = health.deployment;
  const title = `Prod release ${health.status === 'unhealthy' ? 'failing' : 'stale'}: ${project.repo}`;
  const description = `Vercel production deploy is unhealthy for \`${project.repo}\`.

Status: ${health.status} — ${health.reason}
Latest relevant deploy: ${dep.uid} (${dep.state})
Inspector: ${dep.inspectorUrl || '(none)'}
URL: ${dep.url ? `https://${dep.url}` : '(none)'}

Diagnose the failure, push a fix to \`main\`, and confirm the next deploy goes READY.`;

  const taskId = randomUUID();
  let inserted: { id: string } | undefined;
  try {
    const rows = await db
      .insert(tasks)
      .values({
        id: taskId,
        workspaceId: project.workspaceId,
        title: title.slice(0, 200),
        description,
        priority: 8,
        status: 'pending',
        mode: 'execution',
        creationSource: 'webhook',
        category: 'bug',
        roleSlug: project.roleSlug,
        context: {
          repo: project.repo,
          deploymentId: dep.uid,
          watchedProjectId: project.id,
          watcherKind: 'prod_unhealthy',
          health: health.status,
        },
      })
      .returning({ id: tasks.id });
    inserted = rows[0];
  } catch (err) {
    console.error(`[health-watcher] prod task insert failed for ${health.dedupeKey}:`, err);
  }

  try {
    await db.insert(watcherEvents).values({
      projectId: project.id,
      kind: 'prod_unhealthy',
      dedupeKey: health.dedupeKey,
      taskId: inserted?.id ?? null,
      meta: {
        deploymentId: dep.uid,
        state: dep.state,
        reason: health.reason,
        inspectorUrl: dep.inspectorUrl,
      },
    });
  } catch {
    if (inserted) {
      await db.delete(tasks).where(eq(tasks.id, inserted.id));
    }
    return false;
  }

  if (inserted) {
    await dispatchNewTask(
      { id: inserted.id, title, description, workspaceId: project.workspaceId },
      workspace,
    );
  }

  notify({
    app: project.pushoverApp,
    title,
    message: health.reason,
    priority: 1,
    url: dep.inspectorUrl || undefined,
    urlTitle: dep.inspectorUrl ? 'Open deploy' : undefined,
  });

  return true;
}

export function matchesFilter(
  pr: { labels: string[]; title: string },
  filter: { base?: string; label?: string; titlePrefix?: string },
): boolean {
  if (filter.label && !pr.labels.includes(filter.label)) return false;
  if (filter.titlePrefix && !pr.title.startsWith(filter.titlePrefix)) return false;
  return true;
}

export interface RawCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
}

/**
 * Filter raw GH check-runs to ones that count as failing for our purposes.
 * Only completed runs with a failure-like conclusion qualify — in-progress
 * or skipped runs are not "broken yet."
 */
export function filterFailingCheckRuns(runs: RawCheckRun[]): CheckRunSummary[] {
  return runs
    .filter((r) => {
      const conclusion = r.conclusion ?? null;
      return r.status === 'completed' && conclusion && ['failure', 'timed_out', 'cancelled'].includes(conclusion);
    })
    .map((r) => ({
      name: r.name ?? 'unknown',
      conclusion: r.conclusion ?? null,
      htmlUrl: r.html_url ?? null,
    }));
}

export function dedupeKeyForPr(prNumber: number, headSha: string): string {
  return `pr-${prNumber}-${headSha}`;
}

async function listOpenPRs(
  installationId: number,
  owner: string,
  name: string,
  baseRef: string,
): Promise<OpenPR[]> {
  const path = `/repos/${owner}/${name}/pulls?state=open&base=${encodeURIComponent(baseRef)}&per_page=30`;
  const data = await githubApi(installationId, path);
  if (!Array.isArray(data)) return [];
  return data.map((pr: Record<string, unknown>) => ({
    number: pr.number as number,
    title: (pr.title as string) ?? '',
    htmlUrl: (pr.html_url as string) ?? '',
    headSha: ((pr.head as Record<string, unknown>)?.sha as string) ?? '',
    baseRef: ((pr.base as Record<string, unknown>)?.ref as string) ?? baseRef,
    labels: ((pr.labels as Array<{ name?: string }>) ?? [])
      .map((l) => l?.name ?? '')
      .filter(Boolean),
    updatedAt: (pr.updated_at as string) ?? '',
  }));
}

async function failingChecksFor(
  installationId: number,
  owner: string,
  name: string,
  sha: string,
): Promise<CheckRunSummary[]> {
  const path = `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`;
  const data = await githubApi(installationId, path);
  const runs = (data?.check_runs ?? []) as RawCheckRun[];
  return filterFailingCheckRuns(runs);
}

async function isPrSuppressed(project: WatchedProject, pr: OpenPR): Promise<boolean> {
  // Recent activity proxy: PR updated within inFlightWindowMin.
  if (pr.updatedAt) {
    const updatedMs = new Date(pr.updatedAt).getTime();
    const ageMin = (Date.now() - updatedMs) / 60_000;
    if (ageMin < project.inFlightWindowMin) return true;
  }

  // Active buildd task already targeting this PR.
  const active = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, project.workspaceId),
        inArray(tasks.status, ACTIVE_TASK_STATUSES),
        sql`${tasks.context}->>'watchedProjectId' = ${project.id}`,
        sql`(${tasks.context}->>'pr')::int = ${pr.number}`,
      ),
    )
    .limit(1);
  return active.length > 0;
}

async function firePrAlert(
  project: WatchedProject,
  pr: OpenPR,
  failing: CheckRunSummary[],
  dedupeKey: string,
): Promise<boolean> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, project.workspaceId),
  });
  if (!workspace) return false;

  await ensureOpsRole(project.workspaceId, project.roleSlug);

  const checkList = failing
    .map((c) => `- ${c.name} (${c.conclusion ?? 'failure'})${c.htmlUrl ? ` — ${c.htmlUrl}` : ''}`)
    .join('\n');
  const description = `CI is failing on PR #${pr.number} (\`${project.repo}\`).

PR: ${pr.htmlUrl}
Head SHA: \`${pr.headSha}\`

Failing checks:
${checkList}

Investigate, fix, and push. Ping if the failure is flaky or out of scope for this PR.`;

  const taskId = randomUUID();
  let inserted: { id: string } | undefined;
  try {
    const rows = await db
      .insert(tasks)
      .values({
        id: taskId,
        workspaceId: project.workspaceId,
        title: `CI failing on #${pr.number}: ${pr.title}`.slice(0, 200),
        description,
        priority: 5,
        status: 'pending',
        mode: 'execution',
        creationSource: 'webhook',
        category: 'bug',
        roleSlug: project.roleSlug,
        context: {
          repo: project.repo,
          pr: pr.number,
          headSha: pr.headSha,
          watchedProjectId: project.id,
          watcherKind: 'failing_release_pr',
        },
      })
      .returning({ id: tasks.id });
    inserted = rows[0];
  } catch (err) {
    // Likely a dedupe race (another tick fired); fall through and record event below.
    console.error(`[health-watcher] task insert failed for ${dedupeKey}:`, err);
  }

  // Record event (unique on projectId+kind+dedupeKey). If this throws on conflict,
  // it means another tick already fired — that's fine, suppress duplicate work.
  try {
    await db.insert(watcherEvents).values({
      projectId: project.id,
      kind: 'failing_release_pr',
      dedupeKey,
      taskId: inserted?.id ?? null,
      meta: {
        prTitle: pr.title,
        prUrl: pr.htmlUrl,
        failing: failing.map((c) => ({ name: c.name, conclusion: c.conclusion })),
      },
    });
  } catch {
    // Unique-violation: another worker already fired for this key. Clean up our task.
    if (inserted) {
      await db.delete(tasks).where(eq(tasks.id, inserted.id));
    }
    return false;
  }

  if (inserted) {
    await dispatchNewTask(
      { id: inserted.id, title: `CI failing on #${pr.number}`, description, workspaceId: project.workspaceId },
      workspace,
    );
  }

  notify({
    app: project.pushoverApp,
    title: `CI failing on ${project.repo} #${pr.number}`,
    message: `${failing.length} check(s) red\n${pr.title}`,
    priority: 0,
    url: pr.htmlUrl,
    urlTitle: 'Open PR',
  });

  return true;
}

async function resolveInstallationId(repo: string): Promise<number | null> {
  const [owner] = repo.split('/');
  if (!owner) return null;
  const row = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.accountLogin, owner))
    .limit(1);
  return row[0]?.installationId ?? null;
}

const OPS_ROLE_CONTENT = `# Ops

You are the Ops role — you fix broken releases, failing CI, and unhealthy deploys.

When you claim a task created by the health watcher:

1. Open the PR or deploy linked in the task context.
2. Reproduce the failure locally if cheap; otherwise read CI logs to identify the root cause.
3. Push a minimal, targeted fix.
4. If the failure is flaky, mark it and ask before retrying CI repeatedly.
5. If the failure is out of scope for the PR (unrelated breakage on \`main\`), open a separate PR rather than expanding the release PR.

Stay surgical. Do not refactor adjacent code. Do not bypass hooks.
`;

/**
 * Ensure a role with the given slug exists for this workspace.
 * Idempotent — relies on the unique (workspaceId, slug) index.
 */
export async function ensureOpsRole(workspaceId: string, slug: string): Promise<void> {
  const content = OPS_ROLE_CONTENT;
  await db
    .insert(workspaceSkills)
    .values({
      id: randomUUID(),
      workspaceId,
      slug,
      name: slug === 'ops' ? 'Ops' : slug,
      description: 'Fixes broken releases, failing CI, and unhealthy deploys (auto-seeded by health watcher).',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      source: 'health_watcher',
      enabled: true,
      origin: 'manual',
      metadata: {},
      color: '#DC2626',
      model: 'inherit',
      isRole: true,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      canDelegateTo: [],
      background: false,
      maxTurns: null,
      mcpServers: {},
      requiredEnvVars: {},
    })
    .onConflictDoNothing();
}
