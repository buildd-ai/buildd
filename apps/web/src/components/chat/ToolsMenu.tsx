'use client';

/**
 * The composer's tools control: each tool group with "Ask first" or "Allow"
 * (lib/chat/permissions.ts). Writes default to Ask first. Admin, read-only and
 * never-in-chat rows are locked. The choice is the viewer's own, per team.
 *
 * The menu and its rows are the kit's (`ToolsMenu` from
 * @builddai/ai-kit/chat/react); this owns buildd's fetch and PATCH of
 * `/api/chat/permissions`, with an optimistic toggle that rolls back and says
 * "Not saved" when the PATCH fails. The cell is just `···`, never a count.
 */
import { useEffect, useState } from 'react';
import { ToolsMenu as KitToolsMenu } from '@builddai/ai-kit/chat/react';
import type { ChatToolPermissionRow, GetChatPermissionsResponse } from '@buildd/shared';
import KitMenuCell from './KitMenuCell';

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

  return (
    <KitMenuCell testId="composer-tools">
      <KitToolsMenu rows={rows} onChange={change} busyKey={busy} error={error ? 'Not saved' : undefined} title="Tools" />
    </KitMenuCell>
  );
}
