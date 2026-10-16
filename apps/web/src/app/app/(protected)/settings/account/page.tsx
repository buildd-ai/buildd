import Link from 'next/link';
import SignOutButton from './SignOutButton';
import PersonalProviderKeys from './PersonalProviderKeys';
import KeyboardHintsSetting from './KeyboardHintsSetting';
import StandingRulesSection from './StandingRulesSection';
import YourTeams from './YourTeams';
import SettingsPage from '../_components/SettingsPage';
import Section from '@/components/ui/Section';
import { loadSettingsContext } from '../_lib/settings-context';
import { getInitials } from './initials';

export const dynamic = 'force-dynamic';

/** Settings → Profile (was /app/you; next.config redirects the old path). */
export default async function AccountSettingsPage() {
  const { user, teams, currentTeamId, perms } = await loadSettingsContext();
  const initials = getInitials(user.name, user.email);

  return (
    <SettingsPage title="Profile">
      {/* Who is signed in: one row, sign out beside it. */}
      <div data-testid="profile-identity" className="flex min-h-14 items-center gap-3 border-y border-border-default py-2.5">
        {user.image ? (
          <img src={user.image} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-3 text-sm font-medium text-text-secondary">
            {initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{user.name || 'Unnamed'}</p>
          <p className="break-words text-sm text-text-secondary">{user.email}</p>
        </div>
        <SignOutButton />
      </div>

      <KeyboardHintsSetting initial={user.showKeyboardHints === true} />

      {/* The rules chat loads into every one of your turns; yours only. */}
      <StandingRulesSection />

      {/* What chat runs on for you; your own keys are managed on You › Keys. */}
      {currentTeamId && (
        <Section title="Keys">
          <div className="border-y border-border-default">
            <PersonalProviderKeys teamId={currentTeamId} isAdmin={perms.manage_inference_providers} />
          </div>
        </Section>
      )}

      <Section
        title="Your teams"
        action={teams.length > 0 ? <Link href="/app/settings/team?new=1" className="btn btn-sm h-11 md:h-6">New team</Link> : undefined}
      >
        {teams.length === 0 ? (
          <p className="text-sm text-text-muted">
            No teams.{' '}
            <Link href="/app/settings/team?new=1" className="font-medium text-text-primary underline underline-offset-2">Create a team</Link>
          </p>
        ) : (
          <YourTeams teams={teams} currentTeamId={currentTeamId} userId={user.id} />
        )}
      </Section>
    </SettingsPage>
  );
}
