import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { approvalRequestView } from '@/lib/specs/approval-view';
import SpecApprovalRequest from '@/components/SpecApprovalRequest';

export const dynamic = 'force-dynamic';

/**
 * Confirm a spec approval asked for over MCP or chat (lib/specs/approval.ts).
 * The page reads only; pressing Approve confirms it from this session.
 */
export default async function SpecApprovePage({
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
    const back = `/app/specs/${encodeURIComponent(specId)}/approve${request ? `?request=${encodeURIComponent(request)}` : ''}`;
    redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
  }
  const view = await approvalRequestView(user.id, specId, request ?? null);
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 md:py-10">
      <SpecApprovalRequest specId={specId} token={request ?? ''} view={view} />
    </main>
  );
}
