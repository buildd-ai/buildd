'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export interface WorkspaceWithRunners {
    id: string;
    name: string;
    repo: string | null;
    localPath: string | null;
    createdAt: Date;
    teamId: string | null;
    teamName: string | null;
    runners: {
        action: boolean;
        service: boolean;
        user: boolean;
    };
}

export interface UserTeam {
    id: string;
    name: string;
    slug: string;
    role: string;
    memberCount: number;
}

function CheckIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
    );
}

function XIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
    );
}

export default function WorkspaceList({
    workspaces,
    teams,
}: {
    workspaces: WorkspaceWithRunners[];
    teams: UserTeam[];
}) {
    const router = useRouter();
    const [movingWorkspaceId, setMovingWorkspaceId] = useState<string | null>(null);

    const handleMoveWorkspace = async (workspaceId: string, newTeamId: string) => {
        setMovingWorkspaceId(workspaceId);
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: newTeamId }),
            });
            if (!res.ok) {
                throw new Error('Failed to move workspace');
            }
            router.refresh();
        } catch (e) {
            console.error(e);
            alert('Failed to move workspace. You might not have the correct permissions.');
        } finally {
            setMovingWorkspaceId(null);
        }
    };

    // Group workspaces by team
    const groups = workspaces.reduce((acc, ws) => {
        const key = ws.teamId || 'no-team';
        if (!acc[key]) {
            acc[key] = {
                teamName: ws.teamName || 'Personal / No Team',
                workspaces: [],
            };
        }
        acc[key].workspaces.push(ws);
        return acc;
    }, {} as Record<string, { teamName: string; workspaces: WorkspaceWithRunners[] }>);

    const groupKeys = Object.keys(groups).sort((a, b) => {
        if (a === 'no-team') return 1;
        if (b === 'no-team') return -1;
        return groups[a].teamName.localeCompare(groups[b].teamName);
    });

    if (workspaces.length === 0) {
        return (
            <div className="border border-dashed border-border-default rounded-[10px] p-8">
                <div className="flex flex-col items-center text-center max-w-sm mx-auto">
                    <div className="w-12 h-12 rounded-[10px] bg-surface-3 flex items-center justify-center mb-4">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            <line x1="12" y1="11" x2="12" y2="17" />
                            <line x1="9" y1="14" x2="15" y2="14" />
                        </svg>
                    </div>
                    <h2 className="text-[15px] font-semibold mb-1">No workspaces yet</h2>
                    <p className="text-[13px] text-text-muted mb-5">
                        Workspaces map to repositories. Create one to organize tasks and let agents know where to work.
                    </p>
                    <Link
                        href="/app/workspaces/new"
                        className="px-5 py-2 bg-primary text-white hover:bg-primary-hover rounded-[6px] text-[13px] font-medium"
                    >
                        Create Workspace
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {groupKeys.map((teamId) => {
                const group = groups[teamId];
                return (
                    <div key={teamId} className="space-y-3">
                        <h2 className="text-lg font-semibold tracking-tight">{group.teamName}</h2>
                        <div className="border border-border-default rounded-lg divide-y divide-border-default">
                            {group.workspaces.map((workspace) => (
                                <div
                                    key={workspace.id}
                                    className="p-4 hover:bg-surface-3 transition-colors flex flex-col md:flex-row md:justify-between md:items-start gap-4"
                                >
                                    <Link href={`/app/workspaces/${workspace.id}`} className="flex-1 block group">
                                        <div className="flex items-center gap-2">
                                            <h3 className="font-medium group-hover:text-primary transition-colors">{workspace.name}</h3>
                                        </div>
                                        {workspace.repo && (
                                            <p className="text-sm text-text-muted group-hover:text-text-secondary transition-colors mt-0.5">{workspace.repo}</p>
                                        )}
                                    </Link>

                                    <div className="flex flex-col md:items-end gap-3 md:w-64 shrink-0">
                                        <div className="flex gap-3 items-center text-xs w-full justify-between md:justify-end">
                                            <div className={`flex items-center gap-1 ${workspace.runners.action ? 'text-status-success' : 'text-text-muted'}`} title="GitHub Actions">
                                                {workspace.runners.action ? <CheckIcon /> : <XIcon />}
                                                <span>GH Action</span>
                                            </div>
                                            <div className={`flex items-center gap-1 ${workspace.runners.service ? 'text-status-success' : 'text-text-muted'}`} title="Service Worker">
                                                {workspace.runners.service ? <CheckIcon /> : <XIcon />}
                                                <span>Service</span>
                                            </div>
                                            <div className={`flex items-center gap-1 ${workspace.runners.user ? 'text-status-success' : 'text-text-muted'}`} title="User Worker">
                                                {workspace.runners.user ? <CheckIcon /> : <XIcon />}
                                                <span>User</span>
                                            </div>
                                        </div>

                                        {teams.length > 1 && (
                                            <div className="flex w-full md:justify-end items-center gap-2 text-xs">
                                                <span className="text-text-muted">Move to:</span>
                                                <select
                                                    className="bg-surface-2 border border-border-default text-text-secondary rounded px-2 py-1 text-xs focus:ring-1 focus:ring-primary w-full md:w-auto"
                                                    value={workspace.teamId || ''}
                                                    disabled={movingWorkspaceId === workspace.id}
                                                    onChange={(e) => {
                                                        if (e.target.value && e.target.value !== workspace.teamId) {
                                                            handleMoveWorkspace(workspace.id, e.target.value);
                                                        }
                                                    }}
                                                >
                                                    {!workspace.teamId && <option value="">Select Team...</option>}
                                                    {teams.map((t) => (
                                                        <option key={t.id} value={t.id}>
                                                            {t.name} {t.slug.startsWith('personal') ? '(Personal)' : ''}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
