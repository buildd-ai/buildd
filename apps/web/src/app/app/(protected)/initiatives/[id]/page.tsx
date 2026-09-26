import { db } from '@buildd/core/db';
import { missions, artifacts, workspaces, externalLinks } from '@buildd/core/db/schema';
import { eq, and, desc, inArray, ne, or, isNull } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';
import { loadInitiativeCards } from '@/lib/initiative-cards';
import {
  InitiativeActionButton,
  InitiativeBar,
  InitiativeFacts,
  InitiativeMeta,
  InitiativeMissionLines,
  InitiativeStatusChip,
} from '@/components/initiatives/InitiativeCard';
import InitiativeStatusControl from '@/components/initiatives/InitiativeStatusControl';
import AssignMissionModal, { type AssignableMission } from './AssignMissionModal';

export const dynamic = 'force-dynamic';

/**
 * One initiative (docs/specs/initiatives.md): the card the list shows, at full
 * size, with every mission, the status control, Linear tracking when a child
 * mission is linked, and the initiative's artifacts. The card model is the
 * list's (`loadInitiativeCards`), so the two surfaces cannot disagree.
 */
export default async function InitiativeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  const [loaded] = await loadInitiativeCards({ teamIds, initiativeId: id });
  if (!loaded) notFound();

  // Team-scoped access: team match OR open-access workspace.
  let hasAccess = teamIds.includes(loaded.teamId);
  if (!hasAccess && loaded.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, loaded.workspaceId),
      columns: { accessMode: true },
    });
    hasAccess = ws?.accessMode === 'open';
  }
  if (!hasAccess) notFound();

  const { card } = loaded;
  const childMissionIds = card.segments.map((s) => s.missionId);

  const [initiativeArtifacts, linearRows, assignableMissionRows] = await Promise.all([
    db.query.artifacts.findMany({
      where: eq(artifacts.initiativeId, id),
      orderBy: [desc(artifacts.updatedAt)],
      limit: 20,
      columns: { id: true, title: true, type: true, shareToken: true, updatedAt: true },
    }),
    // Linear read-back: mount the tracking panel only when a child mission is linked.
    childMissionIds.length > 0
      ? db
          .select({ id: externalLinks.id })
          .from(externalLinks)
          .where(and(
            eq(externalLinks.provider, 'linear'),
            eq(externalLinks.builddEntityType, 'mission'),
            inArray(externalLinks.builddEntityId, childMissionIds),
          ))
          .limit(1)
      : Promise.resolve([]),
    // Missions the picker can link: same team, not already under this initiative.
    db.query.missions.findMany({
      where: and(eq(missions.teamId, loaded.teamId), or(isNull(missions.initiativeId), ne(missions.initiativeId, id))),
      columns: { id: true, title: true, workspaceId: true, initiativeId: true },
      with: {
        workspace: { columns: { id: true, name: true } },
        initiative: { columns: { id: true, title: true } },
      },
      orderBy: [desc(missions.createdAt)],
      limit: 100,
    }),
  ]);

  const assignableMissions: AssignableMission[] = assignableMissionRows.map((m) => ({
    id: m.id,
    title: m.title,
    workspaceName: (m.workspace as any)?.name || null,
    initiativeId: m.initiativeId || null,
    initiativeTitle: (m.initiative as any)?.title || null,
  }));

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-4 md:pt-8 pb-10 max-w-[1180px]">
      <nav className="mb-5 flex min-w-0 items-center gap-2 font-mono text-[12px] text-text-muted">
        <Link href="/app/initiatives" className="shrink-0 hover:text-text-secondary">Initiatives</Link>
        <span aria-hidden="true">/</span>
        <span className="truncate text-text-secondary">{card.title}</span>
      </nav>

      <header data-testid="initiative-detail" className="card px-4 py-5 md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <InitiativeStatusChip status={card.status} label={card.statusLabel} />
            <h1 className="mt-2 font-mono text-[22px] font-semibold leading-tight tracking-[-0.5px] text-text-primary md:text-[26px]">
              {card.title}
            </h1>
            <div className="mt-2">
              <InitiativeMeta card={card} />
            </div>
          </div>
          <div className="hidden shrink-0 md:block">
            <InitiativeActionButton initiativeId={card.id} action={card.action} />
          </div>
        </div>

        {card.description && (
          <p className="mt-3 max-w-[70ch] whitespace-pre-wrap text-[14px] leading-relaxed text-text-secondary">{card.description}</p>
        )}

        {card.segments.length > 0 && (
          <div className="mt-5">
            <InitiativeBar segments={card.segments} size="lg" />
          </div>
        )}
        {card.facts.length > 0 && (
          <div className="mt-3">
            <InitiativeFacts card={card} />
          </div>
        )}
        {card.action && (
          <div className="mt-4 md:hidden">
            <InitiativeActionButton initiativeId={card.id} action={card.action} />
          </div>
        )}

        <div className="mt-5 border-t border-border-default pt-4">
          <InitiativeStatusControl initiativeId={card.id} status={card.status} />
        </div>
      </header>

      <section id="missions" className="mt-8">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-label text-text-muted">
            Missions <span className="text-text-secondary">{card.missions.length}</span>
          </h2>
          <div className="flex items-center gap-2">
            <AssignMissionModal initiativeId={id} initiativeTitle={card.title} assignableMissions={assignableMissions} />
            <Link
              href={`/app/missions/new?initiative=${encodeURIComponent(id)}`}
              className="inline-flex min-h-11 items-center border-2 border-primary bg-primary px-3 font-mono text-[12px] font-semibold text-white shadow-sm hover:bg-primary-hover md:min-h-9"
            >
              + New mission
            </Link>
          </div>
        </div>
        {card.missions.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-text-secondary mb-1">No missions under this initiative yet.</p>
            <p className="text-xs text-text-muted">Create a mission or add an existing one.</p>
          </div>
        ) : (
          <div className="card px-4 pb-1 md:px-5">
            <div className="-mx-4 md:-mx-5 [&>ul]:border-t-0 [&>ul]:px-4 md:[&>ul]:px-5">
              <InitiativeMissionLines missions={card.missions} detail />
            </div>
          </div>
        )}
      </section>

      {linearRows.length > 0 && (
        <div className="mt-8">
          <TrackerProgressPanel entityType="initiative" entityId={id} />
        </div>
      )}

      {initiativeArtifacts.length > 0 && (
        <section className="mt-8">
          <h2 className="section-label mb-2.5 text-text-muted">
            Artifacts <span className="text-text-secondary">{initiativeArtifacts.length}</span>
          </h2>
          <div className="flex flex-col gap-1.5">
            {initiativeArtifacts.map((a) => (
              <a
                key={a.id}
                href={a.shareToken ? `/share/${a.shareToken}` : '#'}
                className="card flex items-center gap-3 p-3 hover:border-border-hover"
              >
                <span className="flex-1 truncate text-sm text-text-primary">{a.title || 'Untitled'}</span>
                <span className="shrink-0 text-[11px] text-text-muted">{a.type}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
