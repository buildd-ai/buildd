import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadInitiativeCards } from '@/lib/initiative-cards';
import { groupInitiativeCards, initiativesHeadline } from '@/lib/initiative-view';
import { InitiativeList } from './InitiativeList';

export const dynamic = 'force-dynamic';

/**
 * The Initiatives list (docs/specs/initiatives.md). One card per initiative:
 * the status a person set, owner, target date, a bar with one segment per
 * mission, and whatever its missions need from you. Scoped to the active team,
 * like the Missions tab.
 */
export default async function InitiativesListPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/app/auth/signin');

  const teamIds = await getUserTeamIds(user.id);
  const cookieStore = await cookies();
  const activeTeamId = teamIds.length
    ? (await resolveActiveTeamId(user.id, cookieStore.get('buildd-team')?.value)) ?? teamIds[0]
    : null;

  const [loaded, teamRows] = await Promise.all([
    activeTeamId ? loadInitiativeCards({ teamIds: [activeTeamId] }) : Promise.resolve([]),
    activeTeamId
      ? db.select({ name: teams.name }).from(teams).where(eq(teams.id, activeTeamId)).limit(1)
      : Promise.resolve([] as Array<{ name: string }>),
  ]);
  const cards = loaded.map((l) => l.card);
  const teamName = teamRows[0]?.name ?? null;

  if (cards.length === 0) {
    return (
      <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 max-w-[1180px]">
        <div className="card p-8 text-center max-w-md mx-auto mt-10">
          <p className="text-sm text-text-secondary mb-1">No initiatives yet.</p>
          <p className="text-xs text-text-muted mb-4">
            An initiative groups the missions behind one goal, with an owner and a target date.
          </p>
          <Link
            href="/app/initiatives/new"
            className="inline-flex min-h-11 items-center border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white shadow-sm hover:bg-primary-hover md:min-h-9"
          >
            + New initiative
          </Link>
        </div>
      </div>
    );
  }

  const groups = groupInitiativeCards(cards);
  const count = (s: string) => cards.filter((c) => c.section === s).length;
  const headline = initiativesHeadline({ needsYou: count('needs_you'), active: count('active') });
  const summary = groups
    .filter((g) => g.section !== 'needs_you')
    .map((g) => `${g.cards.length} ${g.label.toLowerCase()}`)
    .join(' · ');

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="section-label hidden text-text-muted md:block">
            Initiatives{teamName ? ` · ${teamName}` : ''}
          </div>
          <h1 data-testid="initiatives-headline" className="mt-1.5 font-mono text-[22px] font-semibold tracking-[-0.5px] text-text-primary md:text-[26px]">
            {headline}
          </h1>
          {summary && <p className="mt-1 font-mono text-[12px] text-text-muted">{summary}</p>}
        </div>
        <Link
          href="/app/initiatives/new"
          data-testid="new-initiative-link"
          className="inline-flex min-h-11 items-center self-start border-2 border-primary bg-primary px-3.5 font-mono text-[12.5px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover md:min-h-9 md:self-auto"
        >
          + New initiative
        </Link>
      </div>

      <InitiativeList groups={groups} />
    </div>
  );
}
