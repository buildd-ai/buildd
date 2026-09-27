'use client';

/**
 * The composer's tools control: each tool group with "Ask first" or "Allow"
 * (lib/chat/permissions.ts). Writes default to Ask first. Admin, read-only and
 * never-in-chat rows are locked. The choice is the viewer's own, per team.
 */
import { useEffect, useState } from 'react';
import type { ChatToolPermissionRow, GetChatPermissionsResponse } from '@buildd/shared';
import ComposerMenu from './ComposerMenu';

const LOCKED_LABEL: Record<ChatToolPermissionRow['mode'], string> = {
  ask: 'Ask first',
  allow: 'Allow',
  read: 'Read only',
  never: 'Never',
};

export function ToolRows({ rows, onChange, busy }: {
  rows: readonly ChatToolPermissionRow[];
  onChange(key: string, mode: 'ask' | 'allow'): void;
  busy?: string | null;
}) {
  return (
    <ul data-testid="tools-menu-rows" className="py-1">
      {rows.map(r => (
        <li key={r.key} data-group={r.key} data-mode={r.mode} className="flex min-h-11 items-center justify-between gap-3 px-3 font-mono text-[12.5px]">
          <span className={r.locked ? 'text-text-muted' : 'text-text-primary'}>{r.label}</span>
          {r.locked ? (
            <span className="text-[11.5px] uppercase tracking-[1.2px] text-text-muted">{LOCKED_LABEL[r.mode]}</span>
          ) : (
            <span role="group" aria-label={r.label} className="inline-flex border-[1.5px] border-border-strong">
              {(['ask', 'allow'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={r.mode === m}
                  disabled={busy === r.key}
                  onClick={() => r.mode !== m && onChange(r.key, m)}
                  className={`min-h-8 px-2.5 text-[11.5px] font-semibold ${r.mode === m ? 'bg-text-primary text-surface-1' : 'text-text-secondary hover:bg-surface-3'}`}
                >
                  {m === 'ask' ? 'Ask first' : 'Allow'}
                </button>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function ToolsMenu({ teamId }: { teamId: string }) {
  const [rows, setRows] = useState<ChatToolPermissionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/chat/permissions?teamId=${encodeURIComponent(teamId)}`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<GetChatPermissionsResponse> : null))
      .then(b => { if (live && b) setRows(b.rows); })
      .catch(() => {});
    return () => { live = false; };
  }, [teamId]);

  const change = async (key: string, mode: 'ask' | 'allow') => {
    const before = rows;
    setRows(rs => rs?.map(r => (r.key === key ? { ...r, mode } : r)) ?? rs);
    setBusy(key);
    setError(false);
    try {
      const res = await fetch('/api/chat/permissions', {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, group: key, mode }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setRows(((await res.json()) as GetChatPermissionsResponse).rows);
    } catch {
      setRows(before);
      setError(true);
    } finally {
      setBusy(null);
    }
  };

  const allowed = rows?.filter(r => r.mode === 'allow').length ?? 0;

  return (
    <ComposerMenu
      label="Tools"
      title="Tools"
      testId="composer-tools"
      trigger={(
        <>
          <span aria-hidden="true" className="text-[18px] leading-none">⋯</span>
          {allowed > 0 && <span data-testid="composer-tools-allowed" className="font-mono text-[11px] text-accent-text">{allowed}</span>}
        </>
      )}
    >
      {() => (
        <div>
          <div className="hidden border-b border-border-default px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted sm:block">Tools</div>
          {rows ? <ToolRows rows={rows} onChange={change} busy={busy} /> : <div className="px-3 py-3 font-mono text-[12px] text-text-muted">…</div>}
          {error && <p role="alert" className="border-t border-border-default px-3 py-2 font-mono text-[12px] text-status-error">Not saved</p>}
        </div>
      )}
    </ComposerMenu>
  );
}
