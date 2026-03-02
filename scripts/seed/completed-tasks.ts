/**
 * Seed: Completed Tasks
 *
 * Creates 10 completed tasks with associated memories (discoveries, decisions, gotchas).
 * Useful for testing dashboard history views.
 *
 * Usage: BUILDD_API_KEY=your_key bun run seed:completed-tasks
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

const SEED_TASKS = [
    {
        title: '[SEED] Add user authentication flow',
        description: 'Implement JWT-based authentication with refresh tokens.',
        observations: [
            { type: 'decision', title: 'JWT over session cookies', content: 'Chose JWT with refresh tokens for stateless auth. Session cookies would require sticky sessions in our load-balanced setup.' },
            { type: 'pattern', title: 'Auth middleware pattern', content: 'All protected routes use withAuth() HOC that extracts and validates the JWT from the Authorization header.' },
        ],
    },
    {
        title: '[SEED] Fix N+1 query in dashboard',
        description: 'Dashboard was making individual DB queries for each task\'s worker status.',
        observations: [
            { type: 'gotcha', title: 'Drizzle join returns flat rows', content: 'Drizzle leftJoin returns flat objects, not nested. Must manually group by task ID when joining tasks with workers.' },
        ],
    },
    {
        title: '[SEED] Add workspace settings page',
        description: 'Create settings page for workspace configuration including git config and webhooks.',
        observations: [
            { type: 'discovery', title: 'JSONB column updates require full replacement', content: 'Neon HTTP driver does not support partial JSONB updates. Must read current value, merge changes, and write back the full object.' },
            { type: 'architecture', title: 'Workspace config stored as JSONB', content: 'WorkspaceGitConfig is stored as a JSONB column on the workspaces table. This avoids schema migrations for new config options.' },
        ],
    },
    {
        title: '[SEED] Implement real-time task updates',
        description: 'Add Pusher integration for live task status updates in the dashboard.',
        observations: [
            { type: 'decision', title: 'Pusher over WebSockets', content: 'Chose Pusher over raw WebSockets to avoid managing WebSocket servers on Vercel serverless.' },
        ],
    },
    {
        title: '[SEED] Add API rate limiting',
        description: 'Implement per-account rate limiting for API endpoints.',
        observations: [
            { type: 'pattern', title: 'Rate limit by auth type', content: 'API key users get per-token rate limits, OAuth users get per-session limits. The authType field on accounts determines which strategy applies.' },
            { type: 'gotcha', title: 'Neon HTTP driver no transactions', content: 'Cannot use db.transaction() with neon-http driver. Use atomic UPDATE...WHERE with .returning() for optimistic locking instead.' },
        ],
    },
    {
        title: '[SEED] Create task priority system',
        description: 'Add priority field to tasks with claim ordering.',
        observations: [
            { type: 'discovery', title: 'Priority 0 means highest', content: 'Tasks with priority 0 are claimed first. Higher numbers mean lower priority. NULL priority tasks are claimed last.' },
        ],
    },
    {
        title: '[SEED] Add worker progress tracking',
        description: 'Track worker progress with milestones, token counts, and commit stats.',
        observations: [
            { type: 'architecture', title: 'Worker stats are denormalized', content: 'Token counts, commit stats, and cost are stored directly on the worker row for fast dashboard queries. No separate stats table needed.' },
        ],
    },
    {
        title: '[SEED] Implement workspace memory system',
        description: 'Add observations table for storing workspace knowledge across worker sessions.',
        observations: [
            { type: 'decision', title: 'Flat observation types over hierarchical', content: 'Using flat type enum (discovery, decision, gotcha, pattern, architecture) instead of a category hierarchy. Simpler queries and no depth limits.' },
            { type: 'pattern', title: 'Observation search uses ILIKE', content: 'Search queries use ILIKE against title and content columns. Good enough for workspace-scoped searches without full-text indexes.' },
        ],
    },
    {
        title: '[SEED] Fix worker stale detection',
        description: 'Workers not updated for 15+ minutes should be auto-failed.',
        observations: [
            { type: 'gotcha', title: 'Stale check runs on claim only', content: 'Stale worker detection only runs during claim requests, not on a cron. This means stale workers persist until the next claim attempt.' },
        ],
    },
    {
        title: '[SEED] Add runner worker',
        description: 'Create standalone local UI for running workers outside the web dashboard.',
        observations: [
            { type: 'architecture', title: 'Worker runner is a shared package', content: 'The worker-runner logic lives in packages/core, shared by the runner (apps/runner).' },
            { type: 'discovery', title: 'Claude SDK conversation.sendMessage returns async iterator', content: 'The Claude SDK conversation.sendMessage() returns an async iterator of messages. Must iterate to completion for the turn to finish.' },
        ],
    },
];

async function seedCompletedTasks() {
    console.log('🌱 Seeding: 10 Completed Tasks with Memories');

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
    const createdMemoryIds: string[] = [];

    for (let i = 0; i < SEED_TASKS.length; i++) {
        const seedTask = SEED_TASKS[i];
        console.log(`\n[${i + 1}/10] Creating task: ${seedTask.title}`);

        // Create task
        const taskRes = await fetch(`${API_BASE}/api/tasks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
                title: seedTask.title,
                description: seedTask.description,
                workspaceId: workspace.id,
                priority: i,
            }),
        });

        if (!taskRes.ok) {
            console.error(`Failed to create task ${i + 1}:`, await taskRes.text());
            process.exit(1);
        }

        const { task } = await taskRes.json();
        createdTaskIds.push(task.id);

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
            console.error(`Failed to claim task ${i + 1}:`, await claimRes.text());
            process.exit(1);
        }

        const { worker } = await claimRes.json();
        createdWorkerIds.push(worker.id);

        // Complete the worker
        await fetch(`${API_BASE}/api/workers/${worker.id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
                status: 'completed',
                progress: 100,
                currentAction: 'Done',
                inputTokens: 10000 + Math.floor(Math.random() * 40000),
                outputTokens: 3000 + Math.floor(Math.random() * 15000),
                commitCount: 1 + Math.floor(Math.random() * 8),
                filesChanged: 1 + Math.floor(Math.random() * 15),
                linesAdded: 10 + Math.floor(Math.random() * 500),
                linesRemoved: Math.floor(Math.random() * 200),
            }),
        });

        // Create memories for this task
        for (const obs of seedTask.observations) {
            const memRes = await fetch(`${API_BASE}/api/workspaces/${workspace.id}/memory`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`,
                },
                body: JSON.stringify({
                    type: obs.type,
                    title: obs.title,
                    content: obs.content,
                    source: `worker:${worker.id}`,
                }),
            });

            if (memRes.ok) {
                const data = await memRes.json();
                const id = data.memory?.id || data.observation?.id;
                if (id) createdMemoryIds.push(id);
            } else {
                console.warn(`  Warning: Failed to create memory "${obs.title}":`, await memRes.text());
            }
        }

        console.log(`  ✓ Task completed with ${seedTask.observations.length} memory(ies)`);
    }

    console.log('\n✅ Seed complete!');
    console.log(`   Created ${createdTaskIds.length} tasks`);
    console.log(`   Created ${createdWorkerIds.length} workers`);
    console.log(`   Created ${createdMemoryIds.length} memories`);
    console.log(`   View at: ${API_BASE}/app/tasks`);

    // Save IDs for cleanup
    const fs = await import('fs');
    fs.writeFileSync('scripts/seed/.last-seed.json', JSON.stringify({
        taskIds: createdTaskIds,
        workerIds: createdWorkerIds,
        memoryIds: createdMemoryIds,
        workspaceId: workspace.id,
        type: 'completed-tasks',
        createdAt: new Date().toISOString(),
    }, null, 2));

    console.log('\n   Run `bun run seed:reset` to clean up.');
}

seedCompletedTasks().catch(console.error);
