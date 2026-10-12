'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useConfirm } from '@/components/useConfirm';
import Notice from '@/components/ui/Notice';
import { TonePill } from '@/components/ui/StatePill';

export interface YourTeam {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
  /** Owners on the team; unknown leaves Leave enabled and the API decides. */
  ownerCount?: number;
}

const ROWS = 'divide-y divide-border-default border-y border-border-default';

const isPersonal = (team: YourTeam) => team.slug.startsWith('personal-');
const isLastOwner = (team: YourTeam) => team.role === 'owner' && team.ownerCount !== undefined && team.ownerCount <= 1;

/**
 * Profile › Your teams: one row per team, a link to its members, and Leave
 * beside every team but a personal one. Leaving is the same
 * DELETE /api/teams/[id]/members/[userId] Members › Danger zone sends, with
 * the same rules (docs/specs/team-permissions.md): never a personal team, and
 * not while you are the last owner.
 */
export default function YourTeams({ teams, currentTeamId, userId }: { teams: YourTeam[]; currentTeamId: string | null; userId: string }) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [leaving, setLeaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function leave(team: YourTeam) {
    if (!(await confirm({ title: `Leave ${team.name}?`, message: `You lose access to ${team.name} and its workspaces.`, confirmLabel: 'Leave team', variant: 'danger' }))) return;
    setLeaving(team.id);
    setError('');
    try {
      const res = await fetch(`/api/teams/${team.id}/members/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'Failed to leave team');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave team');
    } finally {
      setLeaving(null);
    }
  }

  return (
    <>
      {error && <Notice tone="err" className="mb-3" action={{ label: 'Dismiss', onClick: () => setError('') }}>{error}</Notice>}
      <div data-testid="profile-teams" className={ROWS}>
        {teams.map((team) => {
          const lastOwner = isLastOwner(team);
          return (
            <div key={team.id} data-testid={`profile-team-${team.id}`} className="flex min-h-14 items-center gap-3">
              <Link
                // The active team is the Team page as it stands; another opens on its own members.
                href={team.id === currentTeamId ? '/app/settings/team' : `/app/settings/team?team=${encodeURIComponent(team.id)}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 hover:bg-surface-3 transition-colors"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{team.name}</span>
                    {isPersonal(team) && <TonePill tone="q">Personal</TonePill>}
                  </span>
                  <span className="block text-sm text-text-muted">
                    {team.role} · <span className="font-mono">{team.memberCount}</span> {team.memberCount === 1 ? 'member' : 'members'}
                    {lastOwner && ' · Make someone else an owner to leave'}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-text-muted">→</span>
              </Link>
              {!isPersonal(team) && (
                <button
                  type="button"
                  data-testid="profile-leave-team"
                  onClick={() => leave(team)}
                  disabled={lastOwner || leaving !== null}
                  aria-label={`Leave ${team.name}`}
                  className="btn btn-sm h-11 md:h-8 shrink-0"
                >
                  {leaving === team.id ? 'Leaving…' : 'Leave'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {confirmDialog}
    </>
  );
}
