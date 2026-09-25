'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PolicyRescanSheet } from '@/components/PolicyRescanSheet';
import type { HealthItem } from '@/lib/workspace-health';
import { TeamMigrationSection } from './TeamMigrationSection';

interface Props {
    workspace: { id: string; name: string; teamId: string };
    teams: Array<{ id: string; name: string }>;
    items: HealthItem[];
}

const BUTTON = 'btn min-h-11 shrink-0';

const DOT: Record<HealthItem['severity'], string> = {
    warning: 'bg-status-warning',
    action: 'bg-text-muted',
    info: 'bg-status-info',
};

/**
 * What is legacy about this workspace, each line with the one existing action
 * that fixes it. Rules live in `lib/workspace-health.ts`; this only renders them
 * and wires the buttons:
 *
 *   review-policy   → PolicyRescanSheet: POST /api/workspaces/[id]/policy-init
 *                     (the scan behind MCP manage_workspaces action=init), shown
 *                     as a diff, then on Apply PATCH /api/workspaces/[id]/config
 *                     { policyConfig }
 *   restrict-access → PATCH /api/workspaces/[id] { accessMode: 'restricted' }
 *   move-team       → WorkspaceMigrationModal (/migrate/precheck → /migrate/execute)
 */
export function WorkspaceHealthCard({ workspace, teams, items }: Props) {
    const router = useRouter();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [policyOpen, setPolicyOpen] = useState(false);

    if (items.length === 0) return null;

    const onlyOffers = items.every(i => i.severity !== 'warning');

    async function restrictAccess() {
        setBusy('access-open');
        setError(null);
        try {
            const res = await fetch(`/api/workspaces/${workspace.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessMode: 'restricted' }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to restrict access');
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to restrict access');
        } finally {
            setBusy(null);
        }
    }

    function actionButton(item: HealthItem) {
        if (!item.action) return null;
        switch (item.action.kind) {
            case 'review-policy':
                return (
                    <button type="button" className={BUTTON} onClick={() => setPolicyOpen(true)}>
                        {item.action.label}
                    </button>
                );
            case 'restrict-access':
                return (
                    <button type="button" className={BUTTON} disabled={busy === item.id} onClick={restrictAccess}>
                        {busy === item.id ? 'Restricting…' : item.action.label}
                    </button>
                );
            case 'move-team':
                return <TeamMigrationSection workspace={workspace} teams={teams} className={BUTTON} />;
        }
    }

    return (
        <section className="card p-4 mb-8" data-testid="workspace-health-card">
            <h2 className="section-label mb-1">Workspace health</h2>
            {onlyOffers && items.some(i => i.severity === 'action') && (
                <p className="text-xs text-text-muted mb-2">No legacy settings.</p>
            )}
            <ul className="divide-y divide-border-default">
                {items.map(item => (
                    <li
                        key={item.id}
                        data-testid={`workspace-health-${item.id}`}
                        className="flex flex-col gap-2 py-3 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="flex items-start gap-2 min-w-0">
                            <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 ${DOT[item.severity]}`} />
                            <div className="min-w-0">
                                <p className="text-[13px] text-text-primary">{item.label}</p>
                                {item.note && <p className="text-xs text-text-muted mt-0.5">{item.note}</p>}
                            </div>
                        </div>
                        {actionButton(item)}
                    </li>
                ))}
            </ul>
            {error && <p className="mt-3 text-sm text-status-error">{error}</p>}

            <PolicyRescanSheet
                workspaceId={workspace.id}
                title="Proposed policy"
                open={policyOpen}
                onClose={() => setPolicyOpen(false)}
                onApplied={() => {
                    setPolicyOpen(false);
                    router.refresh();
                }}
            />
        </section>
    );
}
