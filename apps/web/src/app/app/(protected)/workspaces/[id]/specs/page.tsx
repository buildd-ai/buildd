import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { specListView } from '@/lib/specs/page-view';
import SpecIndex from '@/components/SpecIndex';

export const dynamic = 'force-dynamic';

/** A workspace's Living Specs: a cluster map above an outline by product and area (living-specs.md §19). */
export default async function WorkspaceSpecsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(`/app/workspaces/${id}/specs`)}`);
  const view = await specListView(user.id, id);
  if (view.state !== 'ok') notFound();
  return (
    <main className="pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10">
      <div className="max-w-3xl space-y-4">
        <header className="flex flex-col gap-1">
          <Link href={`/app/workspaces/${view.workspace.id}`} className="text-meta text-text-muted hover:text-text-primary">
            {view.workspace.name}
          </Link>
          <h1 className="text-xl font-semibold text-text-primary">Specs</h1>
        </header>
        <SpecIndex specs={view.index} options={{ now: view.now, proposals: view.proposals }} workspaceId={view.workspace.id} canAct={view.canAct} canConfirm={view.canConfirm} />
      </div>
    </main>
  );
}
