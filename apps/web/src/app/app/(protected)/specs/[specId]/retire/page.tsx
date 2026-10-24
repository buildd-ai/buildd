import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { statusRequestView } from '@/lib/specs/retire';
import SpecStatusRequest from '@/components/SpecStatusRequest';

export const dynamic = 'force-dynamic';

/**
 * Confirm a retire or restore asked for from an OAuth session
 * (lib/specs/retire.ts; Living Spec b7fc9316 R-11). The page reads only;
 * pressing Confirm makes the change from this session.
 */
export default async function SpecStatusConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ specId: string }>;
  searchParams: Promise<{ request?: string }>;
}) {
  const { specId } = await params;
  const { request } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    const back = `/app/specs/${encodeURIComponent(specId)}/retire${request ? `?request=${encodeURIComponent(request)}` : ''}`;
    redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
  }
  const view = await statusRequestView(user.id, specId, request ?? null);
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 md:py-10">
      <SpecStatusRequest specId={specId} token={request ?? ''} view={view} />
    </main>
  );
}
