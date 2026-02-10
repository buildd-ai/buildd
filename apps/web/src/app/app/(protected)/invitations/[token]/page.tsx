import { db } from '@buildd/core/db';
import { teamInvitations, teams, users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import AcceptInvitationButton from './AcceptButton';

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();

  if (!user) {
    redirect('/app/auth/signin');
  }

  const invitation = await db.query.teamInvitations.findFirst({
    where: eq(teamInvitations.token, token),
  });

  if (!invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Invitation Not Found</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            This invitation link is invalid or has been revoked.
          </p>
          <Link href="/app/workspaces" className="text-violet-600 hover:text-violet-500 font-medium">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // Get team and inviter info
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, invitation.teamId),
  });

  let inviterName: string | null = null;
  if (invitation.invitedBy) {
    const inviter = await db.query.users.findFirst({
      where: eq(users.id, invitation.invitedBy),
      columns: { name: true, email: true },
    });
    inviterName = inviter?.name || inviter?.email || null;
  }

  if (invitation.status === 'accepted') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Already Accepted</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            This invitation has already been accepted. You are a member of <strong>{team?.name}</strong>.
          </p>
          <Link href="/app/workspaces" className="text-violet-600 hover:text-violet-500 font-medium">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const isExpired = invitation.status === 'expired' || new Date(invitation.expiresAt) <= new Date();

  if (isExpired) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Invitation Expired</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            This invitation has expired. Please ask the team admin to send a new invitation.
          </p>
          <Link href="/app/workspaces" className="text-violet-600 hover:text-violet-500 font-medium">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 max-w-md w-full text-center">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Team Invitation</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-1">
          {inviterName ? <>{inviterName} has invited you to join</> : <>You have been invited to join</>}
        </p>
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {team?.name}
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-500 mb-6">
          as <span className="font-medium capitalize">{invitation.role}</span>
        </p>
        <AcceptInvitationButton token={token} />
      </div>
    </div>
  );
}
