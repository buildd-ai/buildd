/**
 * Seed: Weekly Workspace Digest Schedule
 *
 * Opts a single workspace into the weekly knowledge-digest agent task
 * (spec: docs/design/workspace-knowledge-management.md §6.2 / D2). The scheduled
 * task synthesises the last 7 days of merged PRs, completed tasks, and new
 * memories into a concise digest and saves it as a type=summary artifact, which
 * is then auto-indexed into the knowledge store. Deliberately per-workspace and
 * opt-in — nothing auto-enables this.
 *
 * Usage: BUILDD_API_KEY=your_key WORKSPACE_ID=<workspace-uuid> bun run seed:knowledge-digest
 *
 * Idempotent: refuses to create a second schedule with the same name in the
 * workspace. Remove via the dashboard or the delete_schedule MCP action.
 */

import { WEEKLY_DIGEST_SCHEDULE } from '../../packages/core/knowledge-store/consolidation';

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
    const existing = schedules.find(s => s.name === WEEKLY_DIGEST_SCHEDULE.name);
    if (existing) {
        console.log(`Schedule "${existing.name}" already exists (${existing.id}) — nothing to do.`);
        return;
    }

    const createRes = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify(WEEKLY_DIGEST_SCHEDULE),
    });
    if (!createRes.ok) {
        console.error(`Failed to create schedule (${createRes.status}): ${await createRes.text()}`);
        process.exit(1);
    }
    const { schedule } = await createRes.json() as { schedule: { id: string; nextRunAt: string | null } };
    console.log(`Created weekly knowledge-digest schedule ${schedule.id}`);
    console.log(`Cron: ${WEEKLY_DIGEST_SCHEDULE.cronExpression} (${WEEKLY_DIGEST_SCHEDULE.timezone}), next run: ${schedule.nextRunAt ?? 'n/a'}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
