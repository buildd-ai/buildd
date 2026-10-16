import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds, resolveActiveTeamScope } from '@/lib/team-access';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { specHubWorkspaces } from '@/lib/specs/page-view';
import { hubTarget } from '@/lib/specs/hub';
import Card from '@/components/ui/Card';
import Lede from '@/components/ui/Lede';

export const dynamic = 'force-dynamic';

/**
 * The way to a team's specs (lib/specs/hub.ts): the one workspace with
 * specs opens straight away, several are listed with what waits first. The
 * active team's workspaces first; with none there, every workspace of the reader's.
 */
export default async function SpecsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent('/app/specs')}`);
  const scope = await resolveActiveTeamScope(user.id, (await cookies()).get('buildd-team')?.value);
  let target = hubTarget(await specHubWorkspaces(user.id, scope.workspaces));
  // Nothing in the active team: look across every workspace the reader belongs to, so specs elsewhere are still found.
  if (target.kind === 'empty') {
    const ids = await getUserWorkspaceIds(user.id);
    const all = ids.length ? await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, ids)) : [];
    target = hubTarget(await specHubWorkspaces(user.id, all));
  }
  if (target.kind === 'redirect') redirect(target.href);
  return (
    <main className="px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="sr-only md:not-sr-only text-heading font-semibold text-text-primary">Specs</h1>
        {target.kind === 'empty' ? (
          <Lede>
            <span data-testid="specs-hub-empty">No specs. Agents draft them over MCP or in chat, and each one appears here for you to read and approve.</span>
          </Lede>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="specs-hub-list">
            {target.workspaces.map((w) => (
              <li key={w.id}>
                <Card as={Link} href={w.href} interactive padding="sm" className="flex min-h-11 flex-col gap-0.5" data-testid="specs-hub-workspace">
                  <span className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]">{w.name}</span>
                  <span className={`text-meta ${w.waiting ? 'text-status-warning' : 'text-text-muted'}`}>{w.words}</span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
