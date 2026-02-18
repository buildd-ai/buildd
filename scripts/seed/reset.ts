/**
 * Seed Reset: Clean up seeded test data
 *
 * Removes any tasks/workers/observations created by the seed scripts.
 * Handles both single-ID seeds (waiting-input, error-worker) and
 * multi-ID seeds (completed-tasks, multi-user, concurrent).
 *
 * Usage: BUILDD_API_KEY=your_key bun run seed:reset
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}

async function failWorker(workerId: string) {
    try {
        await fetch(`${API_BASE}/api/workers/${workerId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
                status: 'failed',
                error: 'Cleaned up by seed:reset',
            }),
        });
    } catch (e) {
        console.warn(`  Warning: Failed to update worker ${workerId}:`, (e as Error).message);
    }
}

async function deleteTask(taskId: string) {
    try {
        await fetch(`${API_BASE}/api/tasks/${taskId}?force=true`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
            },
        });
    } catch (e) {
        console.warn(`  Warning: Failed to delete task ${taskId}:`, (e as Error).message);
    }
}

async function deleteObservation(workspaceId: string, observationId: string) {
    try {
        await fetch(`${API_BASE}/api/workspaces/${workspaceId}/observations/${observationId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
            },
        });
    } catch (e) {
        console.warn(`  Warning: Failed to delete observation ${observationId}:`, (e as Error).message);
    }
}

async function resetSeeds() {
    console.log('🧹 Resetting seeded data...');

    const fs = await import('fs');
    const path = 'scripts/seed/.last-seed.json';

    if (!fs.existsSync(path)) {
        console.log('No seed data found. Nothing to clean up.');
        process.exit(0);
    }

    const seedData = JSON.parse(fs.readFileSync(path, 'utf-8'));
    console.log(`Found seed "${seedData.type}" from ${seedData.createdAt}`);

    // Collect all worker IDs (single or array)
    const workerIds: string[] = seedData.workerIds || (seedData.workerId ? [seedData.workerId] : []);
    // Collect all task IDs (single or array)
    const taskIds: string[] = seedData.taskIds || (seedData.taskId ? [seedData.taskId] : []);
    // Collect all observation IDs
    const observationIds: string[] = seedData.observationIds || [];
    // Workspace ID for observation cleanup
    const workspaceId: string | undefined = seedData.workspaceId || (seedData.workspaceIds?.[0]);

    // Mark workers as failed to release capacity
    if (workerIds.length > 0) {
        console.log(`Cleaning up ${workerIds.length} worker(s)...`);
        for (const id of workerIds) {
            await failWorker(id);
        }
    }

    // Delete observations
    if (observationIds.length > 0 && workspaceId) {
        console.log(`Deleting ${observationIds.length} observation(s)...`);
        for (const id of observationIds) {
            await deleteObservation(workspaceId, id);
        }
    }

    // Delete tasks (after workers are cleaned up)
    if (taskIds.length > 0) {
        console.log(`Deleting ${taskIds.length} task(s)...`);
        for (const id of taskIds) {
            await deleteTask(id);
        }
    }

    // Remove the last-seed file
    fs.unlinkSync(path);

    console.log('\n✅ Cleanup complete!');
}

resetSeeds().catch(console.error);
