'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PolicyRescanSheet } from '@/components/PolicyRescanSheet';
import type { HealthItem } from '@/lib/workspace-health';

interface Props {
    workspace: { id: string; name: string };
    items: HealthItem[];
}

const BUTTON = 'btn min-h-11 shrink-0';

const DOT: Record<HealthItem['severity'], string> = {
    warning: 'bg-status-warning',
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
 */
export function WorkspaceHealthCard({ workspace, items }: Props) {
    const router = useRouter();
    const [policyOpen, setPolicyOpen] = useState(false);

    if (items.length === 0) return null;

    function actionButton(item: HealthItem) {
        if (!item.action) return null;
        switch (item.action.kind) {
            case 'review-policy':
                return (
                    <button type="button" className={BUTTON} onClick={() => setPolicyOpen(true)}>
                        {item.action.label}
                    </button>
                );
        }
    }

    return (
        <div className="py-4 first:pt-0 last:pb-0" data-testid="workspace-health-card">
            <h3 className="text-sm font-medium text-text-primary">Workspace health</h3>
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
        </div>
    );
}
