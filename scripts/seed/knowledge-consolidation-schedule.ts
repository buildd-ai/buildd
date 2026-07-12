/**
 * Seed: Weekly Knowledge Consolidation Schedule
 *
 * Opts a single workspace into the weekly knowledge-consolidation agent task
 * (spec: docs/design/workspace-knowledge-management.md §5). The scheduled task
 * merges near-duplicate knowledge, archives decayed zero-hit chunks, and emits
 * a consolidation report artifact. Deliberately per-workspace and opt-in —
 * nothing auto-enables this.
 *
 * Usage: BUILDD_API_KEY=your_key WORKSPACE_ID=<workspace-uuid> bun run seed:knowledge-consolidation
 *
 * Idempotent: refuses to create a second schedule with the same name in the
 * workspace. Remove via the dashboard or the delete_schedule MCP action.
 */

import { WEEKLY_CONSOLIDATION_SCHEDULE } from '../../packages/core/knowledge-store/consolidation';

const API_BASE = process.env.BUILDD_SERVER || 'https://buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;
const WORKSPACE_ID = process.env.WORKSPACE_ID;

if (!API_KEY) {
    console.error('BUILDD_API_KEY is required');
    process.exit(1);
}
if (!WORKSPACE_ID) {
    console.error('WORKSPACE_ID is required (the workspace to opt in)');
    process.exit(1);
}

const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
};

async function main() {
    const base = `${API_BASE}/api/workspaces/${WORKSPACE_ID}/schedules`;

    // Idempotency: skip if the schedule already exists
    const listRes = await fetch(base, { headers });
    if (!listRes.ok) {
        console.error(`Failed to list schedules (${listRes.status}): ${await listRes.text()}`);
        process.exit(1);
    }
    const { schedules } = await listRes.json() as { schedules: Array<{ id: string; name: string }> };
    const existing = schedules.find(s => s.name === WEEKLY_CONSOLIDATION_SCHEDULE.name);
    if (existing) {
        console.log(`Schedule "${existing.name}" already exists (${existing.id}) — nothing to do.`);
        return;
    }

    const createRes = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify(WEEKLY_CONSOLIDATION_SCHEDULE),
    });
    if (!createRes.ok) {
        console.error(`Failed to create schedule (${createRes.status}): ${await createRes.text()}`);
        process.exit(1);
    }
    const { schedule } = await createRes.json() as { schedule: { id: string; nextRunAt: string | null } };
    console.log(`Created weekly knowledge-consolidation schedule ${schedule.id}`);
    console.log(`Cron: ${WEEKLY_CONSOLIDATION_SCHEDULE.cronExpression} (${WEEKLY_CONSOLIDATION_SCHEDULE.timezone}), next run: ${schedule.nextRunAt ?? 'n/a'}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
