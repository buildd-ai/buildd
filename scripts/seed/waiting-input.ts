/**
 * Seed: Waiting Input State
 * 
 * Creates a test task with a worker in the 'waiting_input' state.
 * Useful for testing the "Needs Input" UI components.
 * 
 * Usage: BUILDD_API_KEY=your_key bun run seed:waiting-input
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

async function seedWaitingInput() {
    console.log('🌱 Seeding: Waiting Input State');

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
            title: '[SEED] Waiting input test',
            description: 'This task was created by the seed script for UI testing.',
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

    // Update worker to waiting_input state
    console.log('Setting worker to waiting_input state...');
    const updateRes = await fetch(`${API_BASE}/api/workers/${worker.id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            status: 'waiting_input',
            progress: 40,
            currentAction: 'Waiting for auth method selection',
            waitingFor: {
                type: 'question',
                prompt: 'Which authentication method should we use for the new API endpoints?',
                options: ['JWT with refresh tokens', 'Session cookies', 'OAuth2 + PKCE'],
            },
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
        type: 'waiting-input',
        createdAt: new Date().toISOString(),
    }, null, 2));

    console.log('\n   Run `bun run seed:reset` to clean up.');
}

seedWaitingInput().catch(console.error);
