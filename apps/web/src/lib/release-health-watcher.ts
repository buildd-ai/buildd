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

// The repo this release's workspace ships from, resolved via
// pickWorkspaceRepoIdentity — needed to ask GitHub whether a deployed sha
// that differs from headSha is an ancestor-descendant (supersession) rather
// than a genuine mismatch. Either field may be null (App not installed, repo
// unresolved); callers without both simply skip the ancestry check.
export interface RepoIdentity {
  installationId: number | null;
  fullName: string | null;
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

// A deployed sha that differs from a release's own headSha is not
// automatically a broken deploy: main advances continuously, so a *later*
// legitimate merge can land on top of this release's commit during the
// watch window, and the identity endpoint will then report that newer sha.
// GitHub's compare API tells the two cases apart: `ahead`/`identical` means
// headSha is an ancestor of deployedSha (production moved forward, this
// release's code is still live, just superseded) — anything else
// (`behind`/`diverged`, or a 404 meaning headSha no longer exists on the
// branch) means production is genuinely not running what this release
// shipped. Returns null (no signal) on API failure — callers should not
// treat that as a positive supersession finding.
async function isDeployedShaDescendant(
  installationId: number,
  repoFullName: string,
  baseSha: string,
  candidateDescendantSha: string,
): Promise<boolean | null> {
  try {
    const { githubApi } = await import('@/lib/github');
    const compare = await githubApi(
      installationId,
      `/repos/${repoFullName}/compare/${baseSha}...${candidateDescendantSha}`,
    );
    const status = compare?.status as string | undefined;
    return status === 'ahead' || status === 'identical';
  } catch {
    return null;
  }
}

async function markHealthy(release: WatchedRelease, db: DB): Promise<void> {
  await db
    .update(releases)
    .set({ state: 'healthy', healthyAt: new Date(), failureReason: null })
    .where(eq(releases.id, release.id));

  await triggerEvent(channels.workspace(release.workspaceId), events.RELEASE_UPDATED, {
    releaseId: release.id,
    state: 'healthy',
  });
}

export async function probeAndDegrade(
  release: WatchedRelease,
  verificationUrl: string,
  db: DB,
  repoIdentity?: RepoIdentity | null,
): Promise<'ok' | 'degraded' | 'unverified' | 'superseded'> {
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

  if (repoIdentity?.installationId && repoIdentity.fullName) {
    const isSuperseded = await isDeployedShaDescendant(
      repoIdentity.installationId,
      repoIdentity.fullName,
      release.headSha,
      deployedSha,
    );
    if (isSuperseded === true) return 'superseded';
  }

  await degradeRelease(
    release,
    db,
    `deployed sha ${deployedSha} does not match release head sha ${release.headSha}`,
  );
  return 'degraded';
}

// Re-check a release already marked `degraded` by the sha-mismatch path
// above. A row can land there from a false positive (a newer merge landed
// mid-watch-window, before this ancestry check existed, or before it was
// deployed) — this heals it back to `healthy` once the currently-deployed
// sha is confirmed to still contain headSha. Never touches a release
// degraded for a different reason (non-2xx, network error): those describe
// the endpoint itself failing, which a sha comparison can't exonerate.
export async function healSupersededRelease(
  release: WatchedRelease,
  verificationUrl: string,
  db: DB,
  repoIdentity: RepoIdentity,
): Promise<'healed' | 'unresolved'> {
  if (!release.headSha || !repoIdentity.installationId || !repoIdentity.fullName) {
    return 'unresolved';
  }

  const deployedSha = await fetchDeployedSha(verificationUrl);
  if (!deployedSha) return 'unresolved';

  if (deployedSha === release.headSha) {
    await markHealthy(release, db);
    return 'healed';
  }

  const isSuperseded = await isDeployedShaDescendant(
    repoIdentity.installationId,
    repoIdentity.fullName,
    release.headSha,
    deployedSha,
  );
  if (isSuperseded !== true) return 'unresolved';

  await markHealthy(release, db);
  return 'healed';
}
