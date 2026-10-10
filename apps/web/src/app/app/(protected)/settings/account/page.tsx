import Link from 'next/link';
import SignOutButton from './SignOutButton';
import PersonalProviderKeys from './PersonalProviderKeys';
import KeyboardHintsSetting from './KeyboardHintsSetting';
import StandingRulesSection from './StandingRulesSection';
import SettingsPage from '../_components/SettingsPage';
import Section from '@/components/ui/Section';
import { TonePill } from '@/components/ui/StatePill';
import { loadSettingsContext } from '../_lib/settings-context';
import { getInitials } from './initials';

export const dynamic = 'force-dynamic';

const ROWS = 'divide-y divide-border-default border-y border-border-default';

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

      {/* What chat runs on for you; your own keys are managed on Models. */}
      {currentTeamId && (
        <Section title="Models">
          <div className="border-y border-border-default">
            <PersonalProviderKeys teamId={currentTeamId} isAdmin={perms.manage_inference_providers} />
          </div>
        </Section>
      )}

      <Section
        title="Your teams"
        action={teams.length > 0 ? <Link href="/app/settings/team/new" className="btn btn-sm h-11 md:h-6">New team</Link> : undefined}
      >
        {teams.length === 0 ? (
          <p className="text-sm text-text-muted">
            No teams.{' '}
            <Link href="/app/settings/team/new" className="font-medium text-text-primary underline underline-offset-2">Create a team</Link>
          </p>
        ) : (
          <div data-testid="profile-teams" className={ROWS}>
            {teams.map((team) => (
              <Link
                key={team.id}
                // The active team is the Team page as it stands; another opens on its own members.
                href={team.id === currentTeamId ? '/app/settings/team' : `/app/settings/team?team=${encodeURIComponent(team.id)}`}
                className="flex min-h-14 items-center justify-between gap-3 py-2.5 hover:bg-surface-3 transition-colors"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{team.name}</span>
                    {team.slug.startsWith('personal-') && <TonePill tone="q">Personal</TonePill>}
                  </span>
                  <span className="block text-sm text-text-muted">
                    {team.role} · <span className="font-mono">{team.memberCount}</span> {team.memberCount === 1 ? 'member' : 'members'}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-text-muted">→</span>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </SettingsPage>
  );
}
