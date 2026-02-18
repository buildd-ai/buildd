/**
 * Seed: Error Worker State
 *
 * Creates a test task with a worker in the 'error' state (loop detected).
 * Useful for testing error UI and recovery flows.
 *
 * Usage: BUILDD_API_KEY=your_key bun run seed:error-worker
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

async function seedErrorWorker() {
    console.log('🌱 Seeding: Error Worker State');

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

    const workspace = workspaces[0];
    console.log(`Using workspace: ${workspace.name} (${workspace.id})`);

    // Create the task via API
    console.log('Creating task...');
    const taskRes = await fetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            title: '[SEED] Error worker test - loop detected',
            description: 'This task was created by the seed script to test error UI and recovery flows.',
            workspaceId: workspace.id,
            priority: 1,
        }),
    });

    if (!taskRes.ok) {
        console.error('Failed to create task:', await taskRes.text());
        process.exit(1);
    }

    const { task } = await taskRes.json();
    console.log(`Task created: ${task.id}`);

    // Claim the task
    console.log('Claiming task...');
    const claimRes = await fetch(`${API_BASE}/api/workers/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            workspaceIds: [workspace.id],
            runner: 'seed',
        }),
    });

    if (!claimRes.ok) {
        console.error('Failed to claim task:', await claimRes.text());
        process.exit(1);
    }

    const { worker } = await claimRes.json();
    console.log(`Worker ${worker.id} claimed the task.`);

    // Update worker with some progress before the error
    console.log('Simulating worker progress...');
    await fetch(`${API_BASE}/api/workers/${worker.id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            status: 'running',
            progress: 35,
            currentAction: 'Implementing authentication middleware',
            inputTokens: 24500,
            outputTokens: 8200,
            commitCount: 2,
            filesChanged: 5,
            linesAdded: 120,
            linesRemoved: 30,
        }),
    });

    // Set worker to error state
    console.log('Setting worker to error state...');
    const updateRes = await fetch(`${API_BASE}/api/workers/${worker.id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            status: 'error',
            error: 'Loop detected: Agent repeated the same action 5 times without progress. Last action: "Running npm test" failed with exit code 1. The test suite has a circular dependency in auth.test.ts that causes an infinite import loop.',
        }),
    });

    if (!updateRes.ok) {
        console.error('Failed to update worker:', await updateRes.text());
        process.exit(1);
    }

    console.log('\n✅ Seed complete!');
    console.log(`   Task ID: ${task.id}`);
    console.log(`   Worker ID: ${worker.id}`);
    console.log(`   View at: ${API_BASE}/app/tasks/${task.id}`);

    // Save IDs for cleanup
    const fs = await import('fs');
    fs.writeFileSync('scripts/seed/.last-seed.json', JSON.stringify({
        taskId: task.id,
        workerId: worker.id,
        workspaceId: workspace.id,
        type: 'error-worker',
        createdAt: new Date().toISOString(),
    }, null, 2));

    console.log('\n   Run `bun run seed:reset` to clean up.');
}

seedErrorWorker().catch(console.error);
