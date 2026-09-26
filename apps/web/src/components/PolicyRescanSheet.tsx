'use client';

import { useEffect, useState } from 'react';
import BottomSheet from '@/components/BottomSheet';
import { diffPolicyConfig, type PolicyConfigDiff } from '@/lib/workspace-health';
import type { WorkspacePolicyConfig } from '@buildd/shared';

/**
 * Re-scan the repo and review what would change before applying.
 *
 *   open  → POST /api/workspaces/[id]/policy-init (the scan behind MCP
 *           manage_workspaces action=init); the response carries both the
 *           `proposed` policy and the `current` one it would replace
 *   Apply → PATCH /api/workspaces/[id]/config { policyConfig: proposed }
 *
 * Used by the workspace health card ("Review proposed policy") and the Merge
 * Policy page ("Re-scan repo"). Merge-policy paths are detected, never typed —
 * this sheet is the only way to change them.
 */

type ScanState =
    | { status: 'idle' | 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; proposed: WorkspacePolicyConfig; diff: PolicyConfigDiff; repoFullName: string };

export function PolicyRescanSheet({
    workspaceId,
    open,
    title = 'Re-scan repo',
    onClose,
    onApplied,
}: {
    workspaceId: string;
    open: boolean;
    title?: string;
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
                if (cancelled) return;
                setScan({
                    status: 'ready',
                    proposed: data.proposed,
                    diff: diffPolicyConfig(data.current ?? null, data.proposed),
                    repoFullName: data.repoFullName,
                });
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
            setScan({ status: 'idle' });
            onApplied();
        } catch (err) {
            setApplyError(err instanceof Error ? err.message : 'Failed to apply policy');
        } finally {
            setApplying(false);
        }
    }

    return (
        <BottomSheet open={open} onClose={close} title={title} trapFocus testId="policy-rescan-sheet">
            {scan.status === 'loading' && <p className="text-sm text-text-muted">Scanning the repository…</p>}
            {scan.status === 'error' && <p className="text-sm text-status-error">{scan.message}</p>}
            {scan.status === 'ready' && (
                <div className="space-y-4">
                    <p className="text-xs text-text-muted">
                        {scan.repoFullName} · preset <span className="text-text-primary">{scan.proposed.preset}</span>.
                        buildd detected these paths from the repo.
                    </p>
                    <PolicyDiffList diff={scan.diff} />
                    {applyError && <p className="text-sm text-status-error">{applyError}</p>}
                    <div className="flex gap-3">
                        <button type="button" className="btn btn-primary min-h-11" disabled={applying} onClick={apply}>
                            {applying ? 'Applying…' : scan.diff.hasChanges ? 'Apply' : 'Apply anyway'}
                        </button>
                        <button type="button" className="btn btn-quiet min-h-11" onClick={close}>Cancel</button>
                    </div>
                </div>
            )}
        </BottomSheet>
    );
}

/** Per-class path diff: added (+), removed (−), unchanged. Pure render, no state. */
export function PolicyDiffList({ diff }: { diff: PolicyConfigDiff }) {
    return (
        <div className="space-y-2" data-testid="policy-diff">
            {diff.presetChange && (
                <p className="text-xs text-text-secondary">
                    Preset changes from <span className="text-text-primary">{diff.presetChange.from}</span> to{' '}
                    <span className="text-text-primary">{diff.presetChange.to}</span>.
                </p>
            )}
            {!diff.hasChanges && (
                <p className="text-xs text-text-muted" data-testid="policy-diff-unchanged">
                    No changes. The detected paths match the applied policy.
                </p>
            )}
            <ul className="divide-y divide-border-default border-y border-border-default">
                {diff.classes.map(row => {
                    const empty = row.added.length + row.removed.length + row.unchanged.length === 0;
                    return (
                        <li key={row.name} className="py-2" data-testid={`policy-diff-${row.name}`}>
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="text-[13px] text-text-primary">{row.label}</span>
                                <span className="text-[11px] uppercase tracking-wide text-text-secondary">{row.actionLabel}</span>
                            </div>
                            {empty ? (
                                <p className="mt-1 text-xs text-text-muted">No matching paths</p>
                            ) : (
                                <ul className="mt-1 space-y-0.5 font-mono text-xs break-all">
                                    {row.added.map(p => (
                                        <li key={`+${p}`} className="text-status-success" data-diff="added">
                                            <span aria-label="added">+ </span>{p}
                                        </li>
                                    ))}
                                    {row.removed.map(p => (
                                        <li key={`-${p}`} className="text-status-error" data-diff="removed">
                                            <span aria-label="removed">− </span>{p}
                                        </li>
                                    ))}
                                    {row.unchanged.map(p => (
                                        <li key={`=${p}`} className="text-text-secondary" data-diff="unchanged">
                                            <span aria-hidden="true">{'  '}</span>{p}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
