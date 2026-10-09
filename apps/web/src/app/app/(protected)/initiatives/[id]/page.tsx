import { db } from '@buildd/core/db';
import { missions, artifacts, externalLinks } from '@buildd/core/db/schema';
import { eq, and, desc, inArray, ne, or, isNull } from 'drizzle-orm';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import TrackerProgressPanel from '@/components/TrackerProgressPanel';
import { loadInitiativeCards } from '@/lib/initiative-cards';
import {
  InitiativeActionButton,
  InitiativeFacts,
  InitiativeMeta,
  InitiativeMissionLines,
  InitiativeStatusChip,
  InitiativeStrip,
} from '@/components/initiatives/InitiativeCard';
import Eyebrow from '@/components/ui/Eyebrow';
import InitiativeStatusControl from '@/components/initiatives/InitiativeStatusControl';
import AssignMissionModal, { type AssignableMission } from './AssignMissionModal';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

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
    hasAccess = await workspaceOpenToCaller(loaded.workspaceId, { teamIds });
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
      <Link href="/app/initiatives" className="font-mono text-[13px] text-text-muted hover:text-text-primary">‹ Initiatives</Link>

      {/* Header: unboxed (L1), like the mission page's. */}
      <header data-testid="initiative-detail" className="mt-3 flex flex-col gap-2">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="min-w-0 text-xl font-semibold leading-tight text-text-primary md:text-2xl">{card.title}</h1>
              <InitiativeStatusChip status={card.status} label={card.statusLabel} />
            </div>
            <div className="mt-1.5">
              <InitiativeMeta card={card} />
            </div>
          </div>
          {/* Only answering a decision shows here: held missions are armed from their own line. */}
          <div className="shrink-0">
            <InitiativeActionButton initiativeId={card.id} action={card.action} variant="header" />
          </div>
        </div>

        {card.description && (
          <p className="max-w-[70ch] whitespace-pre-wrap text-[14px] leading-relaxed text-text-secondary">{card.description}</p>
        )}

        {card.segments.length > 0 && (
          <div className="mt-2">
            <InitiativeStrip segments={card.segments} />
          </div>
        )}
        <InitiativeFacts card={card} />

        <div className="mt-2">
          <InitiativeStatusControl initiativeId={card.id} status={card.status} />
        </div>
      </header>

      <section id="missions" className="mt-8">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <Eyebrow as="h2" tone="muted">
            Missions <span className="ml-1 font-mono font-normal">{card.missions.length}</span>
          </Eyebrow>
          <div className="flex items-center gap-2">
            <AssignMissionModal initiativeId={id} initiativeTitle={card.title} assignableMissions={assignableMissions} />
            <Link href={`/app/missions/new?initiative=${encodeURIComponent(id)}`} className="btn btn-sm h-11 md:h-6">
              + New mission
            </Link>
          </div>
        </div>
        {card.missions.length === 0 ? (
          <p className="text-body text-text-secondary">No missions in this initiative.</p>
        ) : (
          <div className="border-b border-border-default">
            <InitiativeMissionLines missions={card.missions} detail />
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
          <Eyebrow as="h2" tone="muted" className="mb-2.5 block">
            Artifacts <span className="ml-1 font-mono font-normal">{initiativeArtifacts.length}</span>
          </Eyebrow>
          <div className="flex flex-col border-b border-border-default">
            {initiativeArtifacts.map((a) => (
              <a
                key={a.id}
                href={a.shareToken ? `/share/${a.shareToken}` : '#'}
                className="flex min-h-11 items-center gap-3 border-t border-border-default py-2.5 hover:text-text-primary"
              >
                <span className="flex-1 truncate text-sm text-text-primary">{a.title || 'Untitled'}</span>
                <span className="shrink-0 font-mono text-meta text-text-muted">{a.type}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
