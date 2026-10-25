'use client';

/**
 * Edit what one connection reaches in one team (Settings → Connected apps):
 * No access, All current and future workspaces, or Specific workspaces. The
 * choice is a native radio group, so arrow keys move it and Tab leaves it.
 *
 * Switching to Specific workspaces starts from what the connection reaches in
 * the team now, so a person reviews the current set and saving freezes
 * exactly what is ticked. Before Save, the review says in words what changes,
 * and any widening (all workspaces, a new team, an added workspace) is
 * spelled out with the permission it inherits. On a failed save the edits
 * stay; Save again retries. The parent owns the request and its revision.
 */
import { useCallback, useId, useMemo, useState } from 'react';
import Notice from '@/components/ui/Notice';
import type { ConnectionSummary, TeamModeChange } from '@/lib/mcp-grant-patch';
import type { ConsentTeam } from '@/lib/oauth/account-consent';
import WorkspacePicker from './WorkspacePicker';
import { MODE_LABEL, editableWorkspaces, initialTeamSelection, reviewTeamEdit, teamAccess, type TeamChoice } from './connections-view';

const DETAIL: Record<TeamChoice, (team: string) => string> = {
  none: (team) => `Nothing in ${team}.`,
  all: (team) => `Every workspace in ${team} now, and any created in or moved into it later, with this connection's permission. Internal workspaces are not included.`,
  specific: (team) => `Only the workspaces you tick. Workspaces added to ${team} later are not included.`,
};

export default function TeamAccessEditor({
  connection,
  team,
  initialChoice,
  saving,
  error,
  onCancel,
  onSave,
}: {
  connection: ConnectionSummary;
  /** The team with every workspace in it, from the person's teams. */
  team: ConsentTeam;
  /** Where the editor starts; defaults to the team's current mode. */
  initialChoice?: TeamChoice;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (change: TeamModeChange) => void;
}) {
  const current = teamAccess(connection, team.id);
  const [choice, setChoice] = useState<TeamChoice>(initialChoice ?? current?.mode ?? 'all');
  const [selected, setSelected] = useState<string[]>(() => initialTeamSelection(connection, team.id));
  const onSelectionChange = useCallback((ids: string[]) => setSelected(ids), []);
  const offered = useMemo(() => editableWorkspaces(team, initialTeamSelection(connection, team.id)), [team, connection]);
  const review = reviewTeamEdit({ connection, team: offered, choice, selected });
  const name = useId();
  const reviewId = useId();

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-border-default bg-card p-3" data-testid="team-access-editor" data-team={team.id}>
      <fieldset className="space-y-2" aria-describedby={reviewId}>
        <legend className="mb-1 text-title font-semibold text-text-primary">{connection.clientName} in {team.name}</legend>
        {(['none', 'all', 'specific'] as const).map((value) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)] ${choice === value ? 'border-text-primary' : 'border-border-default'}`}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
              data-testid={`team-mode-${value}`}
              className="mt-1 h-4 w-4 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-title font-semibold text-text-primary">{MODE_LABEL[value]}{current?.mode === value || (!current && value === 'none') ? <span className="ml-2 text-meta font-normal text-text-muted">current</span> : null}</span>
              <span className="block text-meta text-text-muted">{DETAIL[value](team.name)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === 'specific' && (
        <WorkspacePicker
          teams={[offered]}
          clientName={connection.clientName}
          initialSelected={selected}
          onSelectionChange={onSelectionChange}
          hideActions
        />
      )}

      <div id={reviewId} aria-live="polite" data-testid="team-access-review">
        {review.invalid ? (
          <p className="text-body text-text-secondary">{review.invalid}</p>
        ) : review.change ? (
          <div className={`space-y-1 rounded-[var(--radius-card)] border p-3 ${review.expands ? 'border-[var(--dec-frame)]' : 'border-border-default'}`} data-expands={review.expands ? 'true' : 'false'}>
            <p className="text-meta font-semibold text-text-secondary">{review.expands ? 'This widens access' : 'This narrows access'}</p>
            {review.lines.map((l) => <p key={l} className="text-body text-text-primary">{l}</p>)}
          </div>
        ) : (
          <p className="text-body text-text-muted">Pick a different option to see what changes.</p>
        )}
      </div>

      {error && <Notice tone="err" data-testid="team-access-error">{error} Your choices are kept; press Save to try again.</Notice>}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-sm h-11 md:h-8" onClick={onCancel} disabled={saving}>Cancel</button>
        <button
          type="button"
          data-testid="team-access-save"
          className="btn btn-primary btn-sm h-11 md:h-8"
          disabled={saving || !review.change}
          aria-busy={saving}
          onClick={() => { if (review.change && !saving) onSave(review.change); }}
        >
          {saving ? 'Saving…' : review.expands ? 'Allow and save' : 'Save'}
        </button>
      </div>
    </div>
  );
}
