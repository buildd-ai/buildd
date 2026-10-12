import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { specPageView } from '@/lib/specs/page-view';
import SpecPage from '@/components/SpecPage';

export const dynamic = 'force-dynamic';

const positive = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};

/**
 * One Living Spec (living-specs.md §8): the revision in force, its history,
 * the changes between two revisions (?from=&to=), one revision (?revision=N),
 * and for an approver the waiting revision (?review=1). Read-only but for the
 * Approve action, which posts to the approve route.
 */
export default async function SpecDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ specId: string }>;
  searchParams: Promise<{ revision?: string; from?: string; to?: string; review?: string }>;
}) {
  const { specId } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(`/app/specs/${specId}`)}`);
  const from = positive(sp.from);
  const to = positive(sp.to);
  const view = await specPageView(user.id, specId, {
    revision: positive(sp.revision),
    ...(from !== undefined && to !== undefined ? { from, to } : {}),
    review: sp.review === '1',
  });
  if (view.state !== 'ok') notFound();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
      <SpecPage view={view} />
    </main>
  );
}
