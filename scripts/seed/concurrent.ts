/**
 * Seed: Concurrent Workers (Capacity Limit)
 *
 * Creates an account's maxConcurrentWorkers worth of active workers,
 * then demonstrates the 429 capacity enforcement response.
 * Useful for testing capacity limit UI and enforcement.
 *
 * Usage: BUILDD_API_KEY=your_key bun run seed:concurrent
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

const WORKER_SCENARIOS = [
    {
        title: '[SEED] Concurrent: Implementing search feature',
        description: 'Full-text search with Postgres tsvector.',
        update: {
            status: 'running',
            progress: 45,
            currentAction: 'Adding search index to documents table',
            inputTokens: 18000,
            outputTokens: 6000,
            commitCount: 2,
            filesChanged: 4,
        },
    },
    {
        title: '[SEED] Concurrent: Setting up CI pipeline',
        description: 'GitHub Actions workflow for build and test.',
        update: {
            status: 'running',
            progress: 70,
            currentAction: 'Configuring test matrix',
            inputTokens: 22000,
            outputTokens: 8500,
            commitCount: 3,
            filesChanged: 2,
        },
    },
    {
        title: '[SEED] Concurrent: Fixing CSS layout bug',
        description: 'Dashboard sidebar overlaps main content on mobile.',
        update: {
            status: 'running',
            progress: 20,
            currentAction: 'Investigating responsive breakpoints',
            inputTokens: 8000,
            outputTokens: 3000,
        },
    },
];

async function seedConcurrent() {
    console.log('🌱 Seeding: Concurrent Workers (Capacity Limit)');

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

    const createdTaskIds: string[] = [];
    const createdWorkerIds: string[] = [];

    // Create tasks and claim workers up to the limit
    console.log('\nCreating tasks and claiming workers...');

    for (let i = 0; i < WORKER_SCENARIOS.length; i++) {
        const scenario = WORKER_SCENARIOS[i];
        console.log(`\n[${i + 1}/${WORKER_SCENARIOS.length}] ${scenario.title}`);

        // Create task
        const taskRes = await fetch(`${API_BASE}/api/tasks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
                title: scenario.title,
                description: scenario.description,
                workspaceId: workspace.id,
                priority: i,
            }),
        });

        if (!taskRes.ok) {
            console.error(`  Failed to create task:`, await taskRes.text());
            process.exit(1);
        }

        const { task } = await taskRes.json();
        createdTaskIds.push(task.id);
        console.log(`  Task created: ${task.id}`);

        // Claim the task
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
            const errorText = await claimRes.text();
            if (claimRes.status === 429) {
                console.log(`  ⚠ Capacity limit reached (429) — this is expected if your account limit is < ${WORKER_SCENARIOS.length}`);
                console.log(`  Response: ${errorText}`);
                continue;
            }
            console.error(`  Failed to claim task:`, errorText);
            process.exit(1);
        }

        const { worker } = await claimRes.json();
        createdWorkerIds.push(worker.id);

        // Set worker to running state
        await fetch(`${API_BASE}/api/workers/${worker.id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(scenario.update),
        });

        console.log(`  ✓ Worker ${worker.id} → running (${scenario.update.progress}%)`);
    }

    // Try one more claim to demonstrate the 429 response
    console.log('\n--- Testing capacity enforcement ---');

    // Create one more task for the overflow test
    const overflowTaskRes = await fetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            title: '[SEED] Concurrent: Overflow task (should be rejected)',
            description: 'This task exists to test the 429 capacity limit enforcement.',
            workspaceId: workspace.id,
            priority: 5,
        }),
    });

    if (overflowTaskRes.ok) {
        const { task: overflowTask } = await overflowTaskRes.json();
        createdTaskIds.push(overflowTask.id);

        const overflowClaimRes = await fetch(`${API_BASE}/api/workers/claim`, {
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

        if (overflowClaimRes.status === 429) {
            const body = await overflowClaimRes.json();
            console.log('✓ 429 response received (capacity enforcement working):');
            console.log(`  Error: ${body.error}`);
            console.log(`  Limit: ${body.limit}, Current: ${body.current}`);
        } else if (overflowClaimRes.ok) {
            const { worker } = await overflowClaimRes.json();
            createdWorkerIds.push(worker.id);
            console.log(`  Note: Account has more capacity than ${WORKER_SCENARIOS.length}. Worker ${worker.id} was claimed.`);
        } else {
            console.log(`  Unexpected response: ${overflowClaimRes.status}`);
        }
    }

    console.log('\n✅ Seed complete!');
    console.log(`   Created ${createdTaskIds.length} tasks`);
    console.log(`   Created ${createdWorkerIds.length} active workers`);
    console.log(`   View at: ${API_BASE}/app/tasks`);

    // Save IDs for cleanup
    const fs = await import('fs');
    fs.writeFileSync('scripts/seed/.last-seed.json', JSON.stringify({
        taskIds: createdTaskIds,
        workerIds: createdWorkerIds,
        workspaceId: workspace.id,
        type: 'concurrent',
        createdAt: new Date().toISOString(),
    }, null, 2));

    console.log('\n   Run `bun run seed:reset` to clean up.');
}

seedConcurrent().catch(console.error);
