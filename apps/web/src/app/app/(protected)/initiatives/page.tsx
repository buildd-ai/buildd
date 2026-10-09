import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, resolveActiveTeamId } from '@/lib/team-access';
import { loadInitiativeCards } from '@/lib/initiative-cards';
import { groupInitiativeCards, initiativesCountLine } from '@/lib/initiative-view';
import { InitiativeList } from './InitiativeList';

export const dynamic = 'force-dynamic';

/**
 * The Initiatives list (docs/specs/initiatives.md). One L1 row per initiative:
 * the status a person set, owner, target date, a small strip with one cell per
 * mission, and whatever its missions need from you. Scoped to the active team,
 * like the Missions tab, and headed the way Missions is: a sans h1 (hidden on
 * phones, where the shell header names the page), one count line, a small
 * "+ New".
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

  const groups = groupInitiativeCards(cards);
  const countLine = initiativesCountLine(groups);

  return (
    <div className="px-4 sm:px-7 md:px-10 pt-14 md:pt-8 pb-10 max-w-[1180px]">
      <div className="mb-5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          {teamName && <div className="hidden text-meta text-text-muted md:block">{teamName}</div>}
          {/* The mobile header already reads "Initiatives"; show the h1 from md up only. */}
          <h1 data-testid="initiatives-headline" className="sr-only md:not-sr-only text-xl font-semibold text-text-primary">
            Initiatives
          </h1>
          {countLine.length > 0 && (
            <p data-testid="initiatives-count" className="font-mono text-meta text-text-muted md:mt-1">
              {countLine.map((part, i) => (
                <span key={part.text}>
                  {i > 0 && ' · '}
                  <span className={part.needsYou ? 'text-accent-text' : undefined}>{part.text}</span>
                </span>
              ))}
            </p>
          )}
        </div>
        <Link href="/app/initiatives/new" data-testid="new-initiative-link" className="btn h-11 shrink-0 md:h-8">
          + New
        </Link>
      </div>

      {cards.length === 0 ? (
        <p className="text-body text-text-secondary">No initiatives. An initiative groups the missions behind one goal.</p>
      ) : (
        <InitiativeList groups={groups} />
      )}
    </div>
  );
}
