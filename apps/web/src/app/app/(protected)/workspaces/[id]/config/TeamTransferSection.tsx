'use client';

import { useState } from 'react';
import { Select } from '@/components/ui/Select';

interface UserTeam {
    id: string;
    name: string;
    slug: string;
    role: string;
    memberCount: number;
}

interface Props {
    workspaceId: string;
    currentTeamId: string;
    teams: UserTeam[];
}

export function TeamTransferSection({ workspaceId, currentTeamId, teams }: Props) {
    const [selectedTeamId, setSelectedTeamId] = useState('');
    const [transferring, setTransferring] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const otherTeams = teams.filter(t => t.id !== currentTeamId);
    const currentTeam = teams.find(t => t.id === currentTeamId);

    async function handleTransfer() {
        if (!selectedTeamId) return;

        setTransferring(true);
        setError(null);

        try {
            const res = await fetch(`/api/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: selectedTeamId }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to transfer workspace');
            }

            window.location.reload();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to transfer workspace');
            setTransferring(false);
        }
    }

    return (
        <div className="mt-12 border-t border-border pt-8">
            <h2 className="text-xl font-bold mb-2">Transfer Workspace</h2>
            <p className="text-text-muted text-sm mb-4">
                Move this workspace to a different team.
                {currentTeam && <> Currently owned by <strong>{currentTeam.name}</strong>.</>}
            </p>

            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mb-4">
                <p className="text-yellow-200 text-sm">
                    Members of the current team will lose access to this workspace.
                </p>
            </div>

            <div className="flex items-end gap-3">
                <div className="flex-1">
                    <label htmlFor="team-select" className="block text-sm font-medium text-text-secondary mb-1">
                        Target team
                    </label>
                    <Select
                        id="team-select"
                        value={selectedTeamId}
                        onChange={setSelectedTeamId}
                        disabled={transferring}
                        placeholder="Select a team..."
                        options={otherTeams.map(team => ({
                            value: team.id,
                            label: `${team.name} (${team.memberCount} member${team.memberCount !== 1 ? 's' : ''})`,
                        }))}
                    />
                </div>

                <button
                    onClick={handleTransfer}
                    disabled={!selectedTeamId || transferring}
                    className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                >
                    {transferring ? 'Transferring...' : 'Transfer'}
                </button>
            </div>

            {error && (
                <p className="mt-3 text-red-400 text-sm">{error}</p>
            )}
        </div>
    );
}
