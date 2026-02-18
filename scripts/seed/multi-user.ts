/**
 * Seed: Multi-User / Multi-Workspace
 *
 * Creates tasks across 2 workspaces to test collaboration features.
 * If only 1 workspace exists, uses just that one with multiple tasks.
 * Each workspace gets tasks in different states to simulate multi-user activity.
 *
 * Usage: BUILDD_API_KEY=your_key bun run seed:multi-user
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

async function seedMultiUser() {
    console.log('🌱 Seeding: Multi-User / Multi-Workspace');

    // Get workspaces via API
    console.log('Fetching workspaces...');
    const wsRes = await fetch(`${API_BASE}/api/workspaces`, {
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
        },
    });

    if (!wsRes.ok) {
        console.error('Failed to fetch workspaces:', await wsRes.text());
        process.exit(1);
    }

    const { workspaces } = await wsRes.json();
    if (!workspaces || workspaces.length === 0) {
        console.error('No workspaces found. Please create a workspace first.');
        process.exit(1);
    }

    // Use up to 2 workspaces
    const selectedWorkspaces = workspaces.slice(0, 2);
    console.log(`Using ${selectedWorkspaces.length} workspace(s):`);
    for (const ws of selectedWorkspaces) {
        console.log(`  - ${ws.name} (${ws.id})`);
    }

    if (selectedWorkspaces.length < 2) {
        console.log('  Note: Only 1 workspace available. Create a second workspace for full multi-workspace testing.');
    }

    const createdTaskIds: string[] = [];
    const createdWorkerIds: string[] = [];
    const workspaceIds: string[] = selectedWorkspaces.map((ws: { id: string }) => ws.id);

    // Define tasks for each workspace with different states
    const taskSets = [
        {
            workspace: selectedWorkspaces[0],
            tasks: [
                {
                    title: '[SEED] Multi-user: Running migration script',
                    description: 'Worker actively running database migration.',
                    workerState: 'running' as const,
                    workerUpdate: {
                        status: 'running',
                        progress: 60,
                        currentAction: 'Running database migration step 3 of 5',
                        inputTokens: 15000,
                        outputTokens: 5000,
                    },
                },
                {
                    title: '[SEED] Multi-user: Pending code review',
                    description: 'Task waiting to be claimed.',
                    workerState: null, // No worker - stays pending
                },
                {
                    title: '[SEED] Multi-user: Completed API refactor',
                    description: 'Successfully refactored REST endpoints to use new middleware.',
                    workerState: 'completed' as const,
                    workerUpdate: {
                        status: 'completed',
                        progress: 100,
                        currentAction: 'Done',
                        inputTokens: 32000,
                        outputTokens: 12000,
                        commitCount: 4,
                        filesChanged: 8,
                        linesAdded: 245,
                        linesRemoved: 180,
                    },
                },
            ],
        },
        {
            workspace: selectedWorkspaces[selectedWorkspaces.length === 2 ? 1 : 0],
            tasks: [
                {
                    title: '[SEED] Multi-user: Waiting for deploy approval',
                    description: 'Worker needs confirmation before deploying to staging.',
                    workerState: 'waiting_input' as const,
                    workerUpdate: {
                        status: 'waiting_input',
                        currentAction: 'Waiting for deploy approval',
                        waitingFor: {
                            type: 'confirmation',
                            prompt: 'Ready to deploy to staging. The migration will affect 3 tables. Proceed?',
                            options: ['Yes, deploy to staging', 'No, run more tests first'],
                        },
                    },
                },
                {
                    title: '[SEED] Multi-user: Failed test suite',
                    description: 'Worker encountered test failures and stopped.',
                    workerState: 'error' as const,
                    workerUpdate: {
                        status: 'error',
                        error: 'Test suite failed: 3 of 42 tests failing. TypeError in UserService.getProfile - expected object but got undefined.',
                    },
                },
            ],
        },
    ];

    for (const taskSet of taskSets) {
        const ws = taskSet.workspace;
        console.log(`\nWorkspace: ${ws.name}`);

        for (const taskDef of taskSet.tasks) {
            console.log(`  Creating: ${taskDef.title}`);

            // Create task
            const taskRes = await fetch(`${API_BASE}/api/tasks`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`,
                },
                body: JSON.stringify({
                    title: taskDef.title,
                    description: taskDef.description,
                    workspaceId: ws.id,
                    priority: 1,
                }),
            });

            if (!taskRes.ok) {
                console.error(`  Failed to create task:`, await taskRes.text());
                process.exit(1);
            }

            const { task } = await taskRes.json();
            createdTaskIds.push(task.id);

            if (taskDef.workerState) {
                // Claim the task
                const claimRes = await fetch(`${API_BASE}/api/workers/claim`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${API_KEY}`,
                    },
                    body: JSON.stringify({
                        workspaceIds: [ws.id],
                        runner: 'seed',
                    }),
                });

                if (!claimRes.ok) {
                    console.error(`  Failed to claim task:`, await claimRes.text());
                    process.exit(1);
                }

                const { worker } = await claimRes.json();
                createdWorkerIds.push(worker.id);

                // Set worker state
                if (taskDef.workerUpdate) {
                    await fetch(`${API_BASE}/api/workers/${worker.id}`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${API_KEY}`,
                        },
                        body: JSON.stringify(taskDef.workerUpdate),
                    });
                }

                console.log(`  ✓ Worker ${worker.id} → ${taskDef.workerState}`);
            } else {
                console.log(`  ✓ Task ${task.id} → pending (no worker)`);
            }
        }
    }

    console.log('\n✅ Seed complete!');
    console.log(`   Created ${createdTaskIds.length} tasks across ${selectedWorkspaces.length} workspace(s)`);
    console.log(`   Created ${createdWorkerIds.length} workers`);
    console.log(`   View at: ${API_BASE}/app/tasks`);

    // Save IDs for cleanup
    const fs = await import('fs');
    fs.writeFileSync('scripts/seed/.last-seed.json', JSON.stringify({
        taskIds: createdTaskIds,
        workerIds: createdWorkerIds,
        workspaceIds,
        type: 'multi-user',
        createdAt: new Date().toISOString(),
    }, null, 2));

    console.log('\n   Run `bun run seed:reset` to clean up.');
}

seedMultiUser().catch(console.error);
