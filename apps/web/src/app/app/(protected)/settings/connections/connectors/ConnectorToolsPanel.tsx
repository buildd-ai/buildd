'use client';

/**
 * A connector's tools inside its Team apps row: each tool's class as the
 * gateway gives it (read / write / admin / denied) and where that came from
 * (provider annotation, catalog-vetted, admin override, tool name, or not
 * annotated). A team admin flips the two admin marks, read-only and deny,
 * which save the connector's toolPolicy through PATCH /api/connectors/<id>
 * (session only). A member reads the list. Loaded when the row opens.
 *
 * lib/connector-tool-review.ts holds the rules; GET /api/connectors/<id>/tools serves them.
 */
import { useCallback, useEffect, useState } from 'react';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import { TOOL_SOURCE_LABEL, type ConnectorToolRow } from '@/lib/connector-tool-labels';

const CLASS_TONE: Record<ConnectorToolRow['cls'], ChipTone> = { read: 'success', query: 'success', write: 'warning', admin: 'error', denied: 'muted' };

export interface ConnectorToolsData { canManage: boolean; snapshotAt: string | null; tools: ConnectorToolRow[] }

/** The route's answer, or null for anything else (a proxy page, an old server). */
function asData(v: unknown): ConnectorToolsData | null {
  const d = v as Partial<ConnectorToolsData> | null;
  return d && Array.isArray(d.tools) ? { canManage: !!d.canManage, snapshotAt: d.snapshotAt ?? null, tools: d.tools } : null;
}

export default function ConnectorToolsPanel({ connectorId, appName, initial }: {
  connectorId: string;
  appName: string;
  /** Fixture only: render this data and load nothing. */
  initial?: ConnectorToolsData;
}) {
  const [data, setData] = useState<ConnectorToolsData | null>(initial ?? null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (initial) return;
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}/tools`);
      const d = res.ok ? asData(await res.json()) : null;
      if (!d) throw new Error();
      setData(d);
    } catch { setFailed(true); }
  }, [connectorId, initial]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(tool: ConnectorToolRow, list: 'readOnly' | 'deny', on: boolean) {
    if (!data || busy) return;
    const readOnly = new Set(data.tools.filter(t => t.adminReadOnly).map(t => t.name));
    const deny = new Set(data.tools.filter(t => t.adminDenied).map(t => t.name));
    const target = list === 'readOnly' ? readOnly : deny;
    if (on) target.add(tool.name); else target.delete(tool.name);
    setBusy(`${tool.name}:${list}`); setError(null);
    try {
      const res = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolPolicy: { readOnlyTools: [...readOnly].sort(), denyTools: [...deny].sort() } }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) { setError(body.message || body.error || `Couldn’t change ${tool.name}.`); return; }
      const fresh = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}/tools`).catch(() => null);
      const d = fresh?.ok ? asData(await fresh.json().catch(() => null)) : null;
      if (d) setData(d);
    } catch { setError('Couldn’t reach buildd. Try again.'); }
    finally { setBusy(null); }
  }

  if (failed) return <p className="text-meta text-text-muted" data-testid="connector-tools-failed">Couldn’t load the tools for {appName}.</p>;
  if (!data) return <p className="text-meta text-text-muted">Loading tools…</p>;

  return (
    <div className="space-y-2" data-testid={`connector-tools-${connectorId}`}>
      <div>
        <span className="text-body font-medium text-text-primary">Tools</span>
        <p className="text-meta text-text-muted">
          {data.tools.length === 0
            ? 'No tools listed.'
            : 'A read grant covers read tools only. Anything not annotated counts as a write until you mark it read-only.'}
        </p>
      </div>
      {data.tools.length > 0 && (
        <ul className="divide-y divide-[var(--line-soft)] border-y border-[var(--line-soft)]">
          {data.tools.map(t => (
            <li key={t.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid={`connector-tool-${t.name}`}>
              <span className="min-w-0 flex-1 break-all font-mono text-body text-text-primary">{t.name}</span>
              <Chip tone={CLASS_TONE[t.cls]} dot={false} data-testid={`connector-tool-class-${t.name}`}>{t.cls}</Chip>
              <span className="text-meta text-text-muted" data-testid={`connector-tool-source-${t.name}`}>{TOOL_SOURCE_LABEL[t.source]}</span>
              {data.canManage && (
                <span className="flex basis-full gap-4 md:basis-auto">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-meta text-text-secondary md:min-h-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={t.adminReadOnly}
                      disabled={!!busy || t.adminDenied}
                      onChange={e => void toggle(t, 'readOnly', e.target.checked)}
                      aria-label={`Treat ${t.name} as read-only`}
                      data-testid={`connector-tool-readonly-${t.name}`}
                    />
                    Read-only
                  </label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-meta text-text-secondary md:min-h-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={t.adminDenied}
                      disabled={!!busy}
                      onChange={e => void toggle(t, 'deny', e.target.checked)}
                      aria-label={`Deny ${t.name}`}
                      data-testid={`connector-tool-deny-${t.name}`}
                    />
                    Deny
                  </label>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-meta text-status-error">{error}</p>}
    </div>
  );
}
