import { db as _db } from '@buildd/core/db';
import { releases, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { dispatchNewTask } from '@/lib/task-dispatch';

type DB = typeof _db;

const PROBE_TIMEOUT_MS = 5_000;
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

// Deployment is asynchronous: a release can flip to `healthy` off a single
// probe that happened to land on an edge node that already has the new code,
// while other regions are still serving the previous deployment for a short
// while longer. Five minutes comfortably covers that global-propagation lag
// (typically well under a minute) without hiding a genuinely stuck deploy for
// long against an hourly watch cadence.
const SHA_GRACE_MINUTES = 5;

export interface WatchedRelease {
  id: string;
  workspaceId: string;
  verificationStrategy: string;
  deployUrl: string | null;
  headSha: string | null;
  healthyAt: Date | null;
}

export async function degradeRelease(
  release: WatchedRelease,
  db: DB,
  reason: string,
): Promise<void> {
  await db
    .update(releases)
    .set({ state: 'degraded', failureReason: reason })
    .where(eq(releases.id, release.id));

  await triggerEvent(channels.workspace(release.workspaceId), events.RELEASE_UPDATED, {
    releaseId: release.id,
    state: 'degraded',
  });

  await autoFileDegradationTask(release, db, reason);
}

export async function autoFileDegradationTask(
  release: WatchedRelease,
  db: DB,
  reason: string,
): Promise<void> {
  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, release.workspaceId),
        sql`${tasks.status} NOT IN ('completed', 'failed', 'cancelled')`,
        sql`${tasks.context}->>'releaseId' = ${release.id}`,
        sql`${tasks.context}->>'type' = 'degradation'`,
      ),
    )
    .limit(1);

  if (existing.length > 0) return;

  const shortId = release.id.slice(0, 8);
  const title = `[degraded] Release ${shortId} — health check failed`;
  const deployLink = release.deployUrl ? `\nDeploy URL: ${release.deployUrl}` : '';
  const description = `A post-deploy health check failed for release \`${shortId}\`.

Workspace: \`${release.workspaceId}\`${deployLink}
Failure reason: ${reason}
Release detail: ${APP_BASE_URL}/app/releases/${release.id}

Investigate the failure and restore the service to a healthy state.`;

  const ws = await db
    .select({ id: workspaces.id, repo: workspaces.repo, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, release.workspaceId))
    .limit(1);

  const workspace = ws[0] ?? null;

  const [newTask] = await db
    .insert(tasks)
    .values({
      workspaceId: release.workspaceId,
      title,
      description,
      priority: 8,
      status: 'pending',
      mode: 'execution',
      creationSource: 'webhook',
      category: 'bug',
      context: {
        releaseId: release.id,
        type: 'degradation',
      },
    })
    .returning();

  if (!newTask) return;

  await dispatchNewTask(
    { id: newTask.id, title, description, workspaceId: release.workspaceId },
    workspace ?? { id: release.workspaceId },
  );
}

// Fetches the deploy identity endpoint at the same origin as the workspace's
// verificationUrl — that is the origin actual traffic hits, as opposed to
// releases.deployUrl (a specific past Vercel deployment's own host, which
// would trivially "match" regardless of what's live in production).
async function fetchDeployedSha(verificationUrl: string): Promise<string | null> {
  try {
    const origin = new URL(verificationUrl).origin;
    const res = await fetch(new URL('/api/deploy-identity', origin).toString(), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.sha === 'string' ? data.sha : null;
  } catch {
    return null;
  }
}

export async function probeAndDegrade(
  release: WatchedRelease,
  verificationUrl: string,
  db: DB,
): Promise<'ok' | 'degraded' | 'unverified'> {
  try {
    const res = await fetch(verificationUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await degradeRelease(release, db, `health check returned HTTP ${res.status}`);
      return 'degraded';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await degradeRelease(release, db, `health check failed: ${msg}`);
    return 'degraded';
  }

  // Older rows never recorded a head sha — cannot sha-verify them. Not a
  // pass (we haven't checked anything) and not a fail (nothing to compare).
  if (!release.headSha) return 'unverified';

  const deployedSha = await fetchDeployedSha(verificationUrl);
  // Identity endpoint unreachable or malformed: the status probe above
  // already passed, so don't fail the release over a second endpoint's
  // hiccup — just report that sha verification didn't happen this tick.
  if (!deployedSha) return 'unverified';

  if (deployedSha === release.headSha) return 'ok';

  const withinGraceWindow =
    release.healthyAt != null &&
    Date.now() - release.healthyAt.getTime() <= SHA_GRACE_MINUTES * 60_000;
  if (withinGraceWindow) return 'unverified';

  await degradeRelease(
    release,
    db,
    `deployed sha ${deployedSha} does not match release head sha ${release.headSha}`,
  );
  return 'degraded';
}
