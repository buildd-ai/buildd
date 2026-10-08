'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import SettingsSection from '../SettingsSection';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import PrimaryAction from '@/components/ui/PrimaryAction';
import {
  buildMatrix, isDirty, resetRow, toggleRole, toOverrides,
  type ApiPermission, type EditableRole, type MatrixRow,
} from './permissions-matrix';

type Groups = Array<{ title: string; rows: MatrixRow[] }>;

const ROLE_LABEL: Record<EditableRole, string> = { admin: 'Admins', member: 'Members' };

/**
 * Settings → Team → Who can do what. Owners choose, per permission, whether
 * admins and members hold it; owners always do. Everyone else sees the same
 * table read-only, so a refused action has a visible reason.
 */
export default function TeamPermissionsSection({ teamId }: { teamId: string }) {
  const [loaded, setLoaded] = useState<Groups | null>(null);
  const [groups, setGroups] = useState<Groups | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const apply = useCallback((data: { canEdit: boolean; permissions: ApiPermission[] }) => {
    const built = buildMatrix(data.permissions);
    setLoaded(built);
    setGroups(built);
    setCanEdit(data.canEdit);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/teams/${teamId}/permissions`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to load');
        if (live) apply(data);
      } catch (err) {
        if (live) setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load' });
      }
    })();
    return () => { live = false; };
  }, [teamId, apply]);

  const allRows = useMemo(() => groups?.flatMap(g => g.rows) ?? [], [groups]);
  const dirty = !!loaded && isDirty(loaded.flatMap(g => g.rows), allRows);

  function update(name: MatrixRow['name'], change: (row: MatrixRow) => MatrixRow) {
    setMsg(null);
    setGroups(gs => gs?.map(g => ({ ...g, rows: g.rows.map(r => (r.name === name ? change(r) : r)) })) ?? gs);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: toOverrides(allRows) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      apply(data);
      setMsg({ type: 'success', text: 'Saved. It applies to everyone on the team straight away.' });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Who can do what" id="permissions">
      <p className="text-body text-text-secondary">
        {canEdit
          ? 'Choose what admins and members may do. Owners can always do everything. API keys keep their own level.'
          : 'What each role on this team may do. Only an owner can change it.'}
      </p>

      {!groups ? (
        msg ? null : <div className="text-body text-text-tertiary">Loading…</div>
      ) : (
        <div className="space-y-5">
          {/* Column legend, once: the rows below carry the switches. */}
          <div className="flex justify-end gap-4 pr-1 text-chip font-semibold uppercase tracking-[0.5px] text-text-muted" aria-hidden="true">
            <span className="w-16 text-center">Admin</span>
            <span className="w-16 text-center">Member</span>
          </div>
          {groups.map(group => (
            <div key={group.title}>
              <h3 className="section-label mb-1">{group.title}</h3>
              <ul className="divide-y divide-border border-t border-border">
                {group.rows.map(row => (
                  <PermissionRow
                    key={row.name}
                    row={row}
                    editable={canEdit}
                    onToggle={role => update(row.name, r => toggleRole(r, role))}
                    onReset={() => update(row.name, resetRow)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {msg && (
        <p role={msg.type === 'error' ? 'alert' : 'status'} className={`text-body ${msg.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
          {msg.text}
        </p>
      )}

      {canEdit && groups && (
        <div className="flex items-center justify-end gap-3">
          {dirty && (
            <button type="button" className="btn btn-quiet" onClick={() => { setGroups(loaded); setMsg(null); }} disabled={busy}>
              Discard
            </button>
          )}
          <PrimaryAction onClick={save} pending={busy} disabled={!dirty}>
            Save permissions
          </PrimaryAction>
        </div>
      )}
    </SettingsSection>
  );
}

function PermissionRow({
  row, editable, onToggle, onReset,
}: {
  row: MatrixRow;
  editable: boolean;
  onToggle: (role: EditableRole) => void;
  onReset: () => void;
}) {
  return (
    <li className="py-3 flex items-center gap-4" data-testid={`permission-row-${row.name}`}>
      <div className="min-w-0 flex-1">
        <p className="text-body text-text-primary">{row.description}</p>
        {row.locked ? (
          <p className="text-meta text-text-muted">Owners only. This can&apos;t be changed.</p>
        ) : !row.isDefault ? (
          <p className="text-meta text-text-muted">
            Changed from the default.
            {editable && (
              <button type="button" className="ml-2 underline hover:text-text-primary" onClick={onReset}>
                Reset
              </button>
            )}
          </p>
        ) : null}
      </div>
      {(['admin', 'member'] as const).map(role => (
        <div key={role} className="w-16 flex justify-center">
          {row.locked || !editable ? (
            <span className="text-meta text-text-muted" aria-label={`${ROLE_LABEL[role]}: ${row[role] ? 'yes' : 'no'}`}>
              {row[role] ? 'Yes' : 'No'}
            </span>
          ) : (
            <Switch
              label={`${ROLE_LABEL[role]} may: ${row.description}`}
              checked={row[role]}
              onChange={() => onToggle(role)}
              className={SWITCH_HIT_AREA}
            />
          )}
        </div>
      ))}
    </li>
  );
}
