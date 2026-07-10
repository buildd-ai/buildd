import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import ConnectionsClient from './ConnectionsClient';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/app/auth/signin');
  }

  const { connected, error } = await searchParams;

  return <ConnectionsClient connectedId={connected} errorMsg={error} />;
}
