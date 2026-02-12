'use client';

import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';

// Mock worker data for different states
const mockWorkers = {
    'waiting-input': {
        id: 'fixture-worker-waiting-input',
        taskId: 'fixture-task-1',
        workspaceId: 'fixture-workspace',
        accountId: 'fixture-account',
        name: 'fixture-worker-abc123',
        branch: 'buildd/fixture-task',
        status: 'waiting_input' as const,
        waitingFor: {
            type: 'question',
            prompt: 'Which authentication method should we use for the new API endpoints?',
            options: ['JWT with refresh tokens', 'Session cookies', 'OAuth2 + PKCE'],
        },
        costUsd: '0.05',
        inputTokens: 5000,
        outputTokens: 2000,
        turns: 12,
        startedAt: new Date(Date.now() - 3600000),
        completedAt: null,
        error: null,
        localUiUrl: null,
        currentAction: 'Auth method',
        milestones: [
            { label: 'Project setup', timestamp: Date.now() - 3000000 },
            { label: 'Database schema', timestamp: Date.now() - 2000000 },
        ],
        prUrl: null,
        prNumber: null,
        lastCommitSha: 'abc123',
        commitCount: 3,
        filesChanged: 8,
        linesAdded: 150,
        linesRemoved: 20,
        pendingInstructions: null,
        instructionHistory: [],
        createdAt: new Date(Date.now() - 3600000),
        updatedAt: new Date(),
    },
    running: {
        id: 'fixture-worker-running',
        taskId: 'fixture-task-2',
        workspaceId: 'fixture-workspace',
        accountId: 'fixture-account',
        name: 'fixture-worker-def456',
        branch: 'buildd/fixture-task-2',
        status: 'running' as const,
        waitingFor: null,
        costUsd: '0.12',
        inputTokens: 12000,
        outputTokens: 5000,
        turns: 25,
        startedAt: new Date(Date.now() - 7200000),
        completedAt: null,
        error: null,
        localUiUrl: 'http://localhost:8766',
        currentAction: 'Implementing API endpoints',
        milestones: [
            { label: 'Project analysis', timestamp: Date.now() - 6000000 },
            { label: 'Schema design', timestamp: Date.now() - 4000000 },
            { label: 'API scaffolding', timestamp: Date.now() - 2000000 },
        ],
        prUrl: null,
        prNumber: null,
        lastCommitSha: 'def456',
        commitCount: 7,
        filesChanged: 15,
        linesAdded: 420,
        linesRemoved: 85,
        pendingInstructions: null,
        instructionHistory: [],
        createdAt: new Date(Date.now() - 7200000),
        updatedAt: new Date(),
    },
    completed: {
        id: 'fixture-worker-completed',
        taskId: 'fixture-task-3',
        workspaceId: 'fixture-workspace',
        accountId: 'fixture-account',
        name: 'fixture-worker-ghi789',
        branch: 'buildd/fixture-task-3',
        status: 'completed' as const,
        waitingFor: null,
        costUsd: '0.25',
        inputTokens: 25000,
        outputTokens: 10000,
        turns: 50,
        startedAt: new Date(Date.now() - 14400000),
        completedAt: new Date(Date.now() - 3600000),
        error: null,
        localUiUrl: null,
        currentAction: null,
        milestones: [
            { label: 'Analysis complete', timestamp: Date.now() - 12000000 },
            { label: 'Implementation done', timestamp: Date.now() - 8000000 },
            { label: 'Tests passing', timestamp: Date.now() - 5000000 },
            { label: 'PR created', timestamp: Date.now() - 3600000 },
        ],
        prUrl: 'https://github.com/example/repo/pull/123',
        prNumber: 123,
        lastCommitSha: 'ghi789',
        commitCount: 15,
        filesChanged: 25,
        linesAdded: 800,
        linesRemoved: 150,
        pendingInstructions: null,
        instructionHistory: [],
        createdAt: new Date(Date.now() - 14400000),
        updatedAt: new Date(),
    },
    failed: {
        id: 'fixture-worker-failed',
        taskId: 'fixture-task-4',
        workspaceId: 'fixture-workspace',
        accountId: 'fixture-account',
        name: 'fixture-worker-jkl012',
        branch: 'buildd/fixture-task-4',
        status: 'failed' as const,
        waitingFor: null,
        costUsd: '0.08',
        inputTokens: 8000,
        outputTokens: 3000,
        turns: 15,
        startedAt: new Date(Date.now() - 5400000),
        completedAt: new Date(Date.now() - 1800000),
        error: 'Build failed: TypeScript compilation error in src/api/routes.ts',
        localUiUrl: null,
        currentAction: null,
        milestones: [
            { label: 'Started', timestamp: Date.now() - 5000000 },
        ],
        prUrl: null,
        prNumber: null,
        lastCommitSha: 'jkl012',
        commitCount: 2,
        filesChanged: 5,
        linesAdded: 100,
        linesRemoved: 10,
        pendingInstructions: null,
        instructionHistory: [],
        createdAt: new Date(Date.now() - 5400000),
        updatedAt: new Date(),
    },
};

type FixtureState = keyof typeof mockWorkers;

export default function DevFixturesPage({
    searchParams,
}: {
    searchParams: Promise<{ state?: string }>;
}) {
    // This is a client component, so we need to handle searchParams differently
    // For simplicity, we'll use a default or URL hash
    const state = (typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('state')
        : 'waiting-input') as FixtureState || 'waiting-input';

    const worker = mockWorkers[state] || mockWorkers['waiting-input'];

    return (
        <div className="min-h-screen bg-surface-1 p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold mb-2">Dev Fixtures: Worker States</h1>
                    <p className="text-text-secondary mb-4">
                        Use these fixtures to test UI components in isolation without database dependencies.
                    </p>

                    {/* State selector */}
                    <div className="flex gap-2 flex-wrap">
                        {Object.keys(mockWorkers).map((s) => (
                            <a
                                key={s}
                                href={`?state=${s}`}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${state === s
                                    ? 'bg-primary text-white'
                                    : 'bg-surface-3 text-text-secondary hover:bg-surface-4'
                                    }`}
                            >
                                {s}
                            </a>
                        ))}
                    </div>
                </div>

                <div className="bg-surface-2 rounded-xl shadow-lg p-6">
                    <h2 className="text-lg font-semibold mb-4">
                        Active Worker: <span className="text-primary">{state}</span>
                    </h2>
                    <RealTimeWorkerView
                        initialWorker={worker as any}
                        statusColors={{
                            pending: 'bg-status-warning/10 text-status-warning',
                            assigned: 'bg-status-info/10 text-status-info',
                            running: 'bg-status-success/10 text-status-success',
                            waiting_input: 'bg-status-running/10 text-status-running',
                            completed: 'bg-surface-3 text-text-secondary',
                            failed: 'bg-status-error/10 text-status-error',
                        }}
                    />
                </div>

                <div className="mt-6 p-4 bg-surface-3 rounded-lg">
                    <h3 className="font-medium mb-2">Raw Worker Data</h3>
                    <pre className="text-xs overflow-auto max-h-64 p-2 bg-surface-1 text-status-success rounded">
                        {JSON.stringify(worker, null, 2)}
                    </pre>
                </div>
            </div>
        </div>
    );
}
