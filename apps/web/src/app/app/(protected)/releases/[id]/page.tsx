import { db } from '@buildd/core/db';
import { releases, releaseTasks, tasks, missions, workspaces, githubRepos } from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { releaseWatchWindowMinutes } from '@/lib/cron-cadence';
import { deriveReleaseAttributionState } from '@/lib/release-attribution-state';
import StatePill, { StatusPill, TonePill } from '@/components/ui/StatePill';
import Eyebrow from '@/components/ui/Eyebrow';
import type { StateTone } from '@/components/ui/states';
import { isSupersededRelease, releasePill, supersededById } from '../release-display';
import ReleaseAutoRefresh from './ReleaseAutoRefresh';

export const dynamic = 'force-dynamic';

const CI_PILL: Record<string, { tone: StateTone; label: string }> = {
  passing: { tone: 'ok', label: 'CI passing' },
  failing: { tone: 'bad', label: 'CI failing' },
  pending: { tone: 'q', label: 'CI pending' },
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function ReleaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);

  const release = await db.query.releases.findFirst({
    where: eq(releases.id, id),
  });

  if (!release) notFound();

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, release.workspaceId),
    columns: { id: true, name: true, teamId: true, githubRepoId: true },
  });

  if (!ws || !teamIds.includes(ws.teamId)) notFound();

  let repoFullName: string | null = null;
  if (ws.githubRepoId) {
    const repoRow = await db.query.githubRepos.findFirst({
      where: eq(githubRepos.id, ws.githubRepoId),
      columns: { fullName: true },
    });
    repoFullName = repoRow?.fullName ?? null;
  }

  const commitRangeUrl =
    repoFullName && release.previousSha && release.headSha
      ? `https://github.com/${repoFullName}/compare/${release.previousSha}...${release.headSha}`
      : null;

  const edges = await db
    .select({
      taskId: releaseTasks.taskId,
      prNumber: releaseTasks.prNumber,
      commitSha: releaseTasks.commitSha,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      missionId: tasks.missionId,
    })
    .from(releaseTasks)
    .leftJoin(tasks, eq(releaseTasks.taskId, tasks.id))
    .where(eq(releaseTasks.releaseId, id));

  const missionIds = [...new Set(edges.map((e) => e.missionId).filter(Boolean) as string[])];
  const missionRows =
    missionIds.length > 0
      ? await db
          .select({ id: missions.id, title: missions.title })
          .from(missions)
          .where(inArray(missions.id, missionIds))
      : [];

  const [degradationTaskRow] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      sql`${tasks.context}->>'releaseId' = ${id}`,
      sql`${tasks.context}->>'type' = 'degradation'`,
    ))
    .limit(1);
  const degradationTaskId = degradationTaskRow?.id ?? null;

  // Same window the cron actually probes with, derived from its cadence.
  const WATCH_WINDOW_MS = releaseWatchWindowMinutes() * 60 * 1000;
  const watchRemainingMin = release.healthyAt
    ? Math.max(0, Math.floor((WATCH_WINDOW_MS - (Date.now() - new Date(String(release.healthyAt)).getTime())) / 60000))
    : 0;

  const pill = releasePill(release);
  const ciPill = release.ciStateAtDispatch ? CI_PILL[release.ciStateAtDispatch] ?? null : null;
  const superseded = isSupersededRelease(release);
  const successorId = superseded ? supersededById(release.failureReason) : null;
  const [successor] = successorId
    ? await db
        .select({ id: releases.id, version: releases.version })
        .from(releases)
        .where(and(eq(releases.id, successorId), eq(releases.workspaceId, ws.id)))
        .limit(1)
    : [];

  const attributionState = deriveReleaseAttributionState({
    commitsAheadAtDispatch: release.commitsAheadAtDispatch,
    previousSha: release.previousSha,
    headSha: release.headSha,
    attributedCount: edges.length,
  });

  const verifying = release.verificationStrategy === 'http' && release.state === 'deploying';
  const watching = release.verificationStrategy === 'http' && release.state === 'healthy' && watchRemainingMin > 0;
  const hasRun = commitRangeUrl || release.commitsAheadAtDispatch != null || ciPill || release.runUrl || release.deployUrl;

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-4 md:pt-8 pb-10 max-w-3xl">
      <Link href="/app/releases" className="font-mono text-[13px] text-text-muted hover:text-text-primary">‹ Releases</Link>

      {/* Header: unboxed (L1). Version as the title, state as a StatePill, workspace in the meta. */}
      <header data-testid="release-header" className="mt-3 mb-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-mono text-[20px] font-semibold tracking-[-0.2px] text-text-primary md:text-[22px]">
            {release.version ?? 'Unversioned release'}
          </h1>
          <StatePill state={pill.state} label={pill.label} title={pill.title} />
        </div>

        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-meta">
          <div className="flex gap-1.5">
            <dt className="text-text-muted">Workspace</dt>
            <dd className="text-text-secondary">{ws.name}</dd>
          </div>
          {release.dispatchedAt && (
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Dispatched</dt>
              <dd className="font-mono text-text-secondary" title={String(release.dispatchedAt)}>{relativeTime(String(release.dispatchedAt))}</dd>
            </div>
          )}
          {release.deployedAt && (
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Deployed</dt>
              <dd className="font-mono text-text-secondary" title={String(release.deployedAt)}>{relativeTime(String(release.deployedAt))}</dd>
            </div>
          )}
          {release.healthyAt && (
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Healthy</dt>
              <dd className="font-mono text-text-secondary" title={String(release.healthyAt)}>{relativeTime(String(release.healthyAt))}</dd>
            </div>
          )}
          {release.triggeredBy && (
            <div className="flex gap-1.5">
              <dt className="text-text-muted">Triggered by</dt>
              <dd className="text-text-secondary">{release.triggeredBy}</dd>
            </div>
          )}
        </dl>

        {/* Verification folds into the header: the state pill already says healthy/degraded/failed. */}
        {verifying && <p className="font-mono text-meta text-text-muted">Verifying the deploy…</p>}
        {watching && <p className="font-mono text-meta text-text-muted">Watching for {watchRemainingMin} more min</p>}

        {superseded ? (
          <p className="font-mono text-meta text-text-muted">
            Superseded by{' '}
            {successor ? (
              <Link href={`/app/releases/${successor.id}`} className="text-text-secondary hover:text-text-primary hover:underline">
                {successor.version || 'a newer release'}
              </Link>
            ) : (
              'a newer release'
            )}
          </p>
        ) : release.failureReason ? (
          <p className={`font-mono text-meta ${release.state === 'degraded' ? 'text-status-warning' : 'text-status-error'}`}>
            {release.failureReason}
          </p>
        ) : null}
        {release.state === 'degraded' && degradationTaskId && (
          <Link href={`/app/tasks/${degradationTaskId}`} className="w-fit font-mono text-meta text-text-secondary hover:text-text-primary hover:underline">
            View auto-filed task →
          </Link>
        )}
      </header>

      {/* Run: commit range, CI and deploy, as one L1 section. */}
      {hasRun && (
        <section className="border-t border-border-default py-4">
          <Eyebrow as="h2" tone="muted" className="mb-2 block">Run</Eyebrow>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-meta">
            {release.commitsAheadAtDispatch != null && (
              <span className="text-text-secondary">
                {release.commitsAheadAtDispatch} commit{release.commitsAheadAtDispatch !== 1 ? 's' : ''} ahead at dispatch
              </span>
            )}
            {commitRangeUrl ? (
              <a href={commitRangeUrl} target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary hover:underline">
                {release.previousSha?.slice(0, 7)}...{release.headSha?.slice(0, 7)} →
              </a>
            ) : release.commitsAheadAtDispatch != null ? (
              <span className="text-text-muted">
                {attributionState === 'clean'
                  ? 'Nothing shipped in this range'
                  : `Commit range unavailable${release.headSha ? ` (${release.headSha.slice(0, 7)})` : ''}`}
              </span>
            ) : null}
            {ciPill && <TonePill tone={ciPill.tone}>{ciPill.label}</TonePill>}
            {release.runUrl && (
              <a href={release.runUrl} target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary hover:underline">
                Workflow run →
              </a>
            )}
            {release.deployUrl && (
              <a href={release.deployUrl} target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary hover:underline">
                Deploy URL →
              </a>
            )}
          </div>
        </section>
      )}

      {/* Attributed tasks */}
      {edges.length > 0 && (
        <section className="border-t border-border-default py-4">
          <Eyebrow as="h2" tone="muted" className="mb-3 block">
            Tasks <span className="ml-1 font-mono font-normal">{edges.length}</span>
          </Eyebrow>
          <ul className="flex flex-col gap-2">
            {edges.map((edge) => (
              <li key={edge.taskId} className="flex items-center justify-between gap-3 text-body">
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill status={edge.taskStatus ?? 'unknown'} variant="plain" />
                  <Link href={`/app/tasks/${edge.taskId}`} className="truncate text-text-primary hover:underline">
                    {edge.taskTitle ?? 'Untitled task'}
                  </Link>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-text-muted">
                  {edge.prNumber && <span>PR #{edge.prNumber}</span>}
                  {edge.commitSha && <span>{edge.commitSha.slice(0, 7)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Attributed missions */}
      {missionRows.length > 0 && (
        <section className="border-t border-border-default py-4">
          <Eyebrow as="h2" tone="muted" className="mb-3 block">
            Missions <span className="ml-1 font-mono font-normal">{missionRows.length}</span>
          </Eyebrow>
          <ul className="flex flex-col gap-2">
            {missionRows.map((m) => (
              <li key={m.id}>
                <Link href={`/app/missions/${m.id}`} className="text-body text-text-primary hover:underline">
                  {m.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attributionState === 'unseeded' && (
        <p className="border-t border-border-default py-4 text-body text-text-secondary">
          Attribution hasn&apos;t run for this release yet: the commit range is missing or incomplete, so buildd
          can&apos;t match tasks. Expected right after dispatch; check back once the range resolves.
        </p>
      )}

      {attributionState === 'unmatched' && (
        <p className="border-t border-border-default py-4 text-body text-text-secondary">
          Attribution ran but matched no tasks. The commit range is valid, so the matcher likely missed these commits.
        </p>
      )}

      <ReleaseAutoRefresh releaseId={id} workspaceId={ws.id} />
    </div>
  );
}
