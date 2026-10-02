'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PolicyRescanSheet } from '@/components/PolicyRescanSheet';
import type { WorkspaceReadinessItem, WorkspaceReadinessReport } from '@buildd/shared';
import {
    NEXT_STEP_COPY,
    isSelectable,
    missionHref,
    orderedItems,
    rowTone,
    selectableItemIds,
    statusLabel,
    type RowTone,
} from '@/lib/onboarding-view';
import { RepoLinkCard } from './RepoLinkCard';
import { SpecWizard } from './SpecWizard';

const DOT: Record<RowTone, string> = {
    ok: 'bg-status-success',
    warning: 'bg-status-warning',
    muted: 'bg-text-muted',
    info: 'bg-status-info',
};

interface ScaffoldFile {
    path: string;
    group: 'docs' | 'release';
    itemIds: string[];
    commitMessage: string;
    content: string;
}

interface ScaffoldPreview {
    files: ScaffoldFile[];
    skipped: Array<{ itemId: string; reason: string }>;
    prs: Array<{ group: string; title: string; paths: string[] }>;
}

type Load =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; report: WorkspaceReadinessReport };

type Propose =
    | { kind: 'idle' }
    | { kind: 'preview'; preview: ScaffoldPreview }
    | { kind: 'created'; preview: ScaffoldPreview; taskId: string };

/**
 * What a repo has and lacks for buildd workers to do reliable work in it.
 *
 *   load    → GET  /api/workspaces/[id]/readiness   (recomputed every time; never stored)
 *   propose → POST /api/workspaces/[id]/onboarding/scaffold { itemIds }            dry run
 *   confirm → POST /api/workspaces/[id]/onboarding/scaffold { itemIds, confirm }   one PR task
 *
 * Which step the owner is on is `report.nextStep`, nothing remembered here: a
 * file edited elsewhere changes the report and so the step.
 */
export function ReadinessCard({ workspaceId }: { workspaceId: string }) {
    const [load, setLoad] = useState<Load>({ status: 'loading' });
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [propose, setPropose] = useState<Propose>({ kind: 'idle' });
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [policyOpen, setPolicyOpen] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/readiness`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setLoad({ status: 'error', message: data.error || 'Could not check the repository' });
                return;
            }
            const report = data as WorkspaceReadinessReport;
            setLoad({ status: 'ready', report });
            // Drop ticks for rows that stopped being fixable since the last read.
            const live = new Set(selectableItemIds(report));
            setSelected((prev) => new Set([...prev].filter((id) => live.has(id))));
        } catch {
            setLoad({ status: 'error', message: 'Network error. Try again.' });
        }
    }, [workspaceId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function scaffold(confirm: boolean) {
        setBusy(true);
        setActionError(null);
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/onboarding/scaffold`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemIds: [...selected], ...(confirm ? { confirm: true } : { dryRun: true }) }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setActionError(data.error || 'Could not propose changes');
                return;
            }
            const preview: ScaffoldPreview = { files: data.files ?? [], skipped: data.skipped ?? [], prs: data.prs ?? [] };
            setPropose(confirm ? { kind: 'created', preview, taskId: data.task?.id } : { kind: 'preview', preview });
        } catch {
            setActionError('Network error. Try again.');
        } finally {
            setBusy(false);
        }
    }

    function toggle(id: string) {
        setPropose({ kind: 'idle' });
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    if (load.status === 'loading') {
        return (
            <section className="card p-4 mb-8" data-testid="readiness-card" aria-busy="true">
                <h2 className="section-label mb-1">Repo readiness</h2>
                <p className="text-xs text-text-muted animate-pulse">Checking the repository…</p>
            </section>
        );
    }

    if (load.status === 'error') {
        return (
            <section className="card p-4 mb-8" data-testid="readiness-card">
                <h2 className="section-label mb-1">Repo readiness</h2>
                <p role="alert" data-testid="readiness-error" className="text-xs text-status-error mb-2">{load.message}</p>
                <button type="button" className="btn min-h-11" onClick={() => { setLoad({ status: 'loading' }); refresh(); }}>
                    Try again
                </button>
            </section>
        );
    }

    const { report } = load;

    if (report.nextStep === 'link-repo') {
        return <RepoLinkCard workspaceId={workspaceId} onLinked={() => { setLoad({ status: 'loading' }); refresh(); }} />;
    }

    const step = NEXT_STEP_COPY[report.nextStep];
    const fixable = selectableItemIds(report);

    function action(item: WorkspaceReadinessItem) {
        if (item.id === 'merge-policy' && item.fix?.kind === 'apply-config' && !item.waived) {
            return (
                <button type="button" data-testid="readiness-review-policy" className="btn min-h-11 shrink-0" onClick={() => setPolicyOpen(true)}>
                    Review policy
                </button>
            );
        }
        return null;
    }

    return (
        <>
            <section className="card p-4 mb-8" data-testid="readiness-card">
                <h2 className="section-label mb-1">Repo readiness</h2>
                <div className="mb-3" data-testid="readiness-next-step" data-step={report.nextStep}>
                    <p className="text-[13px] text-text-primary">{step.title}</p>
                    <p className="text-xs text-text-muted mt-0.5">{step.body}</p>
                </div>
                {report.truncated && (
                    <p className="text-xs text-text-muted mb-2" data-testid="readiness-truncated">
                        The repository is too large to scan fully, so some items show as unknown rather than missing.
                    </p>
                )}

                <ul className="divide-y divide-border-default">
                    {orderedItems(report.items).map((item) => {
                        const selectable = isSelectable(item);
                        const note = item.waived
                            ? `Waived: ${item.waived.reason}`
                            : (item.status === 'missing' ? item.fix?.summary : undefined) ?? item.value ?? item.evidence[0]?.note;
                        return (
                            <li
                                key={item.id}
                                data-testid={`readiness-row-${item.id}`}
                                data-status={item.status}
                                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="flex items-start gap-2 min-w-0">
                                    {selectable && (
                                        <input
                                            type="checkbox"
                                            data-testid={`readiness-select-${item.id}`}
                                            aria-label={`Propose: ${item.label}`}
                                            className="mt-1 size-4 shrink-0"
                                            checked={selected.has(item.id)}
                                            onChange={() => toggle(item.id)}
                                        />
                                    )}
                                    {!selectable && fixable.length > 0 && <span aria-hidden="true" className="size-4 shrink-0" />}
                                    <span
                                        aria-hidden="true"
                                        data-testid={`readiness-dot-${item.id}`}
                                        data-tone={rowTone(item)}
                                        className={`mt-1.5 size-2 shrink-0 ${DOT[rowTone(item)]}`}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-[13px] text-text-primary">
                                            {item.label}
                                            <span className="ml-2 text-xs text-text-muted" data-testid={`readiness-status-${item.id}`}>
                                                {statusLabel(item)}
                                            </span>
                                        </p>
                                        {note && <p className="text-xs text-text-muted mt-0.5 break-words">{note}</p>}
                                    </div>
                                </div>
                                {action(item)}
                            </li>
                        );
                    })}
                </ul>

                {fixable.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            data-testid="readiness-propose"
                            className="btn btn-primary min-h-11"
                            disabled={selected.size === 0 || busy}
                            onClick={() => scaffold(false)}
                        >
                            {busy && propose.kind === 'idle' ? 'Rendering…' : 'Propose changes'}
                        </button>
                        <button
                            type="button"
                            className="btn btn-quiet min-h-11"
                            onClick={() => {
                                setPropose({ kind: 'idle' });
                                setSelected(selected.size === fixable.length ? new Set() : new Set(fixable));
                            }}
                        >
                            {selected.size === fixable.length ? 'Clear' : 'Select all'}
                        </button>
                    </div>
                )}

                {actionError && (
                    <p role="alert" data-testid="readiness-action-error" className="text-xs text-status-error mt-3">{actionError}</p>
                )}

                {propose.kind === 'preview' && (
                    <div className="mt-4" data-testid="readiness-preview">
                        {propose.preview.files.length === 0 ? (
                            <p className="text-xs text-text-muted">Nothing to add for the selected items.</p>
                        ) : (
                            <>
                                <p className="text-xs text-text-muted mb-2">
                                    A builder will open {propose.preview.prs.length === 1 ? 'a PR' : `${propose.preview.prs.length} PRs`} with these files. Nothing is written to your default branch; you merge the PR.
                                </p>
                                <ul className="space-y-2">
                                    {propose.preview.files.map((f) => (
                                        <li key={f.path} data-testid={`readiness-preview-file`}>
                                            <details>
                                                <summary className="text-[13px] font-mono break-all cursor-pointer min-h-11 flex items-center">{f.path}</summary>
                                                <pre className="text-xs bg-surface-2 border border-border-default p-3 overflow-x-auto max-h-72 whitespace-pre-wrap break-words">{f.content}</pre>
                                            </details>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                        {propose.preview.skipped.length > 0 && (
                            <ul className="text-xs text-text-muted mt-2 list-disc pl-4" data-testid="readiness-preview-skipped">
                                {propose.preview.skipped.map((s) => <li key={s.itemId}>{s.itemId}: {s.reason}</li>)}
                            </ul>
                        )}
                        {propose.preview.files.length > 0 && (
                            <button
                                type="button"
                                data-testid="readiness-confirm"
                                className="btn btn-primary min-h-11 mt-3"
                                disabled={busy}
                                onClick={() => scaffold(true)}
                            >
                                {busy ? 'Creating…' : 'Confirm and open PR'}
                            </button>
                        )}
                    </div>
                )}

                {propose.kind === 'created' && (
                    <p className="text-sm text-text-secondary mt-4" data-testid="readiness-created">
                        A builder task is on its way to open the PR. Review and merge it, then reload this card.
                    </p>
                )}

                {(report.nextStep === 'first-mission' || report.nextStep === 'done') && (
                    <Link href={missionHref(workspaceId)} data-testid="readiness-mission-link" className="btn btn-primary min-h-11 mt-4">
                        Plan your first mission
                    </Link>
                )}
            </section>

            {report.nextStep === 'author-spec' && <SpecWizard workspaceId={workspaceId} />}

            <PolicyRescanSheet
                workspaceId={workspaceId}
                title="Proposed policy"
                open={policyOpen}
                onClose={() => setPolicyOpen(false)}
                onApplied={() => {
                    setPolicyOpen(false);
                    refresh();
                }}
            />
        </>
    );
}
