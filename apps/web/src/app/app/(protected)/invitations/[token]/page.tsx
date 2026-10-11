import { db } from '@buildd/core/db';
import { teamInvitations, teams, users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import AcceptInvitationButton from './AcceptButton';
import Notice from '@/components/ui/Notice';
import type { ReactNode } from 'react';

const FRAME = 'pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10';

/** The invitation page frame: one title, then the one thing to do. */
function InvitationFrame({ children }: { children: ReactNode }) {
  return (
    <main className={FRAME}>
      <div className="max-w-md space-y-6">
        <h1 className="text-xl font-semibold text-text-primary">Team invitation</h1>
        {children}
      </div>
    </main>
  );
}

const HOME = { label: 'Go to home', href: '/app/home' };

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
      <InvitationFrame>
        <Notice tone="err" title="Invitation not found" action={HOME}>
          This invitation link is invalid or revoked.
        </Notice>
      </InvitationFrame>
    );
  }

  // Get team and inviter info. Explicit column list: an unfiltered teams query
  // selects every column in schema.ts, so dropping one takes this page down for
  // the whole build window (db:migrate runs before next build).
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, invitation.teamId),
    columns: { name: true },
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
      <InvitationFrame>
        <Notice tone="ok" title="Already accepted" action={{ label: 'Open team settings', href: '/app/settings/team' }}>
          You already accepted this invitation. You&apos;re a member of <strong>{team?.name}</strong>.
        </Notice>
      </InvitationFrame>
    );
  }

  const isExpired = invitation.status === 'expired' || new Date(invitation.expiresAt) <= new Date();

  if (isExpired) {
    return (
      <InvitationFrame>
        <Notice tone="warn" title="Invitation expired" action={HOME}>
          Ask a team admin to send a new one.
        </Notice>
      </InvitationFrame>
    );
  }

  return (
    <InvitationFrame>
      <div className="space-y-1">
        <p className="text-text-secondary">
          {inviterName ? <>{inviterName} invited you to join</> : <>You&apos;re invited to join</>}
        </p>
        <p className="text-lg font-semibold text-text-primary">{team?.name}</p>
        <p className="text-sm text-text-muted">
          as <span className="font-medium capitalize">{invitation.role}</span>
        </p>
      </div>
      <AcceptInvitationButton token={token} />
    </InvitationFrame>
  );
}
