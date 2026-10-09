'use client';

import { useState } from 'react';

/**
 * Which workspaces the team-wide agent endpoint applies to: all of them, or a
 * chosen list. Saving sends only the list (PATCH, no key), so the saved key is
 * kept as is. A chosen workspace that has its own copy of the same endpoint can
 * have that copy removed so it uses the team one; a copy with a different key,
 * URL or aliases is always kept.
 */

export interface AppliesToWorkspace { id: string; name: string }

/** A workspace's own endpoint row, as the section knows it. */
export interface WorkspaceCopy { workspaceId: string; matchesTeam: boolean }

export function appliesToLabel(appliesTo: readonly AppliesToWorkspace[] | null | undefined): string {
  if (!appliesTo) return 'All workspaces';
  if (appliesTo.length === 0) return 'No workspaces';
  const n = appliesTo.length;
  return `${n} workspace${n === 1 ? '' : 's'}: ${appliesTo.map((w) => w.name).join(', ')}`;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as Record<string, unknown>));
  return typeof body.error === 'string' ? body.error : "That didn’t go through. Try again.";
}

/**
 * The "Applies to" choice itself: all workspaces, or a checklist. Shared by the
 * quick editor below and the full endpoint editor, so both read the same.
 */
export function AppliesToFields({ workspaces, mode, chosen, copies, disabled, onMode, onToggle }: {
  workspaces: AppliesToWorkspace[];
  mode: 'all' | 'some';
  chosen: ReadonlySet<string>;
  copies: WorkspaceCopy[];
  disabled: boolean;
  onMode: (mode: 'all' | 'some') => void;
  onToggle: (id: string, on: boolean) => void;
}) {
  const targets = mode === 'all' ? workspaces.map((w) => w.id) : workspaces.filter((w) => chosen.has(w.id)).map((w) => w.id);
  const copyOf = new Map(copies.map((c) => [c.workspaceId, c]));

  const note = (id: string) => {
    const c = copyOf.get(id);
    if (!c || !targets.includes(id)) return null;
    return c.matchesTeam ? 'Has its own copy of this endpoint' : 'Keeps its own endpoint: different key, URL or aliases';
  };

  const modeRadio = (value: 'all' | 'some', label: string) => (
    <label className="flex items-center gap-2 cursor-pointer min-h-11 md:min-h-0 text-body text-text-primary">
      <input type="radio" name="agent-endpoint-applies" className="control-radio appearance-none" checked={mode === value}
        disabled={disabled} onChange={() => onMode(value)} />
      {label}
    </label>
  );

  return (
    <>
      <fieldset className="space-y-2">
        <legend className="field-label">Applies to</legend>
        {modeRadio('all', 'All workspaces')}
        {modeRadio('some', 'Selected workspaces')}
      </fieldset>
      {mode === 'some' && (
        <ul className="space-y-1 pl-6" aria-label="Workspaces">
          {workspaces.map((w) => (
            <li key={w.id}>
              <label className="flex items-start gap-2 cursor-pointer min-h-11 md:min-h-0 py-1">
                <input type="checkbox" className="control-check appearance-none mt-0.5" checked={chosen.has(w.id)} disabled={disabled}
                  data-testid="agent-endpoint-applies-workspace" data-workspace={w.id}
                  onChange={(e) => onToggle(w.id, e.target.checked)} />
                <span>
                  <span className="block text-body text-text-primary">{w.name}</span>
                  {note(w.id) && <span className="block text-meta text-text-muted">{note(w.id)}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {mode === 'all' && copies.length > 0 && (
        <ul className="space-y-1 pl-6" data-testid="agent-endpoint-applies-copies">
          {workspaces.filter((w) => copyOf.has(w.id)).map((w) => (
            <li key={w.id} className="text-meta text-text-muted">{w.name}: {note(w.id)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function EndpointAppliesToEditor({ teamId, workspaces, appliesTo, copies, onClose, onChanged }: {
  teamId: string;
  workspaces: AppliesToWorkspace[];
  appliesTo: AppliesToWorkspace[] | null;
  copies: WorkspaceCopy[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'all' | 'some'>(appliesTo ? 'some' : 'all');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((appliesTo ?? []).map((w) => w.id)));
  const [consolidate, setConsolidate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const targets = mode === 'all' ? workspaces.map((w) => w.id) : workspaces.filter((w) => chosen.has(w.id)).map((w) => w.id);
  const copyOf = new Map(copies.map((c) => [c.workspaceId, c]));
  const matching = targets.filter((id) => copyOf.get(id)?.matchesTeam);
  const canSave = !busy && (mode === 'all' || targets.length > 0);

  function toggle(id: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/agent-endpoint`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliesTo: mode === 'all' ? null : targets, consolidate: matching.length > 0 && consolidate }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      onClose();
      await onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border-default pt-3" data-testid="agent-endpoint-applies-editor">
      <AppliesToFields workspaces={workspaces} mode={mode} chosen={chosen} copies={copies} disabled={busy}
        onMode={setMode} onToggle={toggle} />
      {matching.length > 0 && (
        <label className="flex items-start gap-2 cursor-pointer text-body text-text-secondary">
          <input type="checkbox" className="control-check appearance-none mt-0.5" checked={consolidate} disabled={busy}
            data-testid="agent-endpoint-consolidate" onChange={(e) => setConsolidate(e.target.checked)} />
          Remove the {matching.length === 1 ? 'matching copy' : `${matching.length} matching copies`} so {matching.length === 1 ? 'it uses' : 'they use'} this endpoint
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>Save</button>
        <button className="btn btn-quiet" onClick={() => { setMsg(null); onClose(); }} disabled={busy}>Cancel</button>
      </div>
      {msg && <p role="alert" className="text-body text-status-error">{msg}</p>}
    </div>
  );
}
