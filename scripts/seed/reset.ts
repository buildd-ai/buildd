/**
 * Seed Reset: Clean up seeded test data
 * 
 * Removes any tasks/workers created by the seed scripts.
 * 
 * Usage: BUILDD_API_KEY=your_key bun run seed:reset
 */

const API_BASE = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
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
    console.log(`Found seed from ${seedData.createdAt}`);

    // Mark worker as failed to release it
    if (seedData.workerId) {
        console.log(`Cleaning up worker ${seedData.workerId}...`);
        try {
            await fetch(`${API_BASE}/api/workers/${seedData.workerId}`, {
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
            console.warn('Warning: Failed to update worker:', (e as Error).message);
        }
    }

    // Delete the task via API
    if (seedData.taskId) {
        console.log(`Deleting task ${seedData.taskId}...`);
        try {
            await fetch(`${API_BASE}/api/tasks/${seedData.taskId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${API_KEY}`,
                },
            });
        } catch (e) {
            console.warn('Warning: Failed to delete task:', (e as Error).message);
        }
    }

    // Remove the last-seed file
    fs.unlinkSync(path);

    console.log('\n✅ Cleanup complete!');
}

resetSeeds().catch(console.error);
