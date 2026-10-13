import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { specPageView } from '@/lib/specs/page-view';
import SpecPage from '@/components/SpecPage';
import { resolveSpecShortId, SHORT_ID } from '@/lib/specs/short-id';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const positive = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};

/**
 * One Living Spec (living-specs.md §9): the revision in force, its history,
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
  // A short id (§18, R-33), the link a generated repo copy prints.
  if (SHORT_ID.test(specId)) {
    const found = await resolveSpecShortId({ kind: 'user', userId: user.id }, specId);
    if (found.state === 'one') redirect(`/app/specs/${found.id}`);
    if (found.state === 'none') notFound();
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pt-[4.5rem] pb-24 md:px-8 md:pt-8 md:pb-10">
        <h1 className="font-voice text-2xl text-text-primary">Specs starting {specId}</h1>
        <p className="mt-1 text-meta text-text-muted">More than one spec you can open starts with this id.</p>
        <ul className="mt-4 flex flex-col gap-2" data-testid="spec-short-id-matches">
          {found.specs.map((s) => (
            <li key={s.id}>
              <Link href={`/app/specs/${s.id}`} className="text-body text-text-primary underline">{s.title}</Link>
              <span className="text-meta text-text-muted"> · {s.workspaceName}</span>
            </li>
          ))}
        </ul>
      </main>
    );
  }
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
