'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import BottomSheet from '@/components/BottomSheet';
import { describePolicyConfig, type HealthItem } from '@/lib/workspace-health';
import type { WorkspacePolicyConfig } from '@buildd/shared';
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
 *   review-policy   → POST /api/workspaces/[id]/policy-init (the scan behind MCP
 *                     manage_workspaces action=init), then on Apply
 *                     PATCH /api/workspaces/[id]/config { policyConfig }
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

            <PolicyReviewSheet
                workspaceId={workspace.id}
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

type ScanState =
    | { status: 'idle' | 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; proposed: WorkspacePolicyConfig; repoFullName: string };

function PolicyReviewSheet({
    workspaceId,
    open,
    onClose,
    onApplied,
}: {
    workspaceId: string;
    open: boolean;
    onClose: () => void;
    onApplied: () => void;
}) {
    const [scan, setScan] = useState<ScanState>({ status: 'idle' });
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);

    // Scan on every open, so a re-open after a repo change rescans.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setScan({ status: 'loading' });
        fetch(`/api/workspaces/${workspaceId}/policy-init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
            .then(async res => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'Could not scan the repository');
                if (!cancelled) setScan({ status: 'ready', proposed: data.proposed, repoFullName: data.repoFullName });
            })
            .catch(err => {
                if (!cancelled) setScan({ status: 'error', message: err instanceof Error ? err.message : 'Scan failed' });
            });
        return () => { cancelled = true; };
    }, [open, workspaceId]);

    function close() {
        setScan({ status: 'idle' });
        setApplyError(null);
        onClose();
    }

    async function apply() {
        if (scan.status !== 'ready') return;
        setApplying(true);
        setApplyError(null);
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ policyConfig: scan.proposed }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to apply policy');
            onApplied();
        } catch (err) {
            setApplyError(err instanceof Error ? err.message : 'Failed to apply policy');
        } finally {
            setApplying(false);
        }
    }

    return (
        <BottomSheet open={open} onClose={close} title="Proposed policy" trapFocus>
            {scan.status === 'loading' && <p className="text-sm text-text-muted">Scanning the repository…</p>}
            {scan.status === 'error' && <p className="text-sm text-status-error">{scan.message}</p>}
            {scan.status === 'ready' && (
                <div className="space-y-4">
                    <p className="text-xs text-text-muted">
                        {scan.repoFullName} · preset <span className="text-text-primary">{scan.proposed.preset}</span>.
                        Paths are detected from the repo.
                    </p>
                    <ul className="divide-y divide-border-default border-y border-border-default">
                        {describePolicyConfig(scan.proposed).map(row => (
                            <li key={row.name} className="py-2">
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[13px] text-text-primary">{row.label}</span>
                                    <span className="text-[11px] uppercase tracking-wide text-text-secondary">{row.actionLabel}</span>
                                </div>
                                {row.paths.length > 0 ? (
                                    <ul className="mt-1 space-y-0.5">
                                        {row.paths.map(p => (
                                            <li key={p} className="font-mono text-xs text-text-secondary break-all">{p}</li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="mt-1 text-xs text-text-muted">No matching paths</p>
                                )}
                            </li>
                        ))}
                    </ul>
                    {applyError && <p className="text-sm text-status-error">{applyError}</p>}
                    <div className="flex gap-3">
                        <button type="button" className="btn btn-primary min-h-11" disabled={applying} onClick={apply}>
                            {applying ? 'Applying…' : 'Apply'}
                        </button>
                        <button type="button" className="btn btn-quiet min-h-11" onClick={close}>Cancel</button>
                    </div>
                </div>
            )}
        </BottomSheet>
    );
}
