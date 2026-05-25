/**
 * Seed a watched_projects row for buildd-ai/buildd in a specific workspace.
 *
 * Usage:
 *   DATABASE_URL="…" bun run scripts/seed-watched-buildd.ts <workspaceId>          # dry run
 *   DATABASE_URL="…" bun run scripts/seed-watched-buildd.ts <workspaceId> --apply  # write
 *
 * After insert, the health watcher cron tick will pick it up on its next run
 * (waits up to 60 min between checks per row).
 */
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const workspaceId = process.argv[2];
if (!workspaceId || workspaceId.startsWith('--')) {
  console.error('Usage: bun run scripts/seed-watched-buildd.ts <workspaceId> [--apply]');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const sql = neon(DATABASE_URL);

const repo = 'buildd-ai/buildd';
const filter = { base: 'main' };

const existing = (await sql`
  SELECT id, enabled FROM watched_projects
  WHERE workspace_id = ${workspaceId} AND repo = ${repo}
`) as Array<{ id: string; enabled: boolean }>;

if (existing.length > 0) {
  console.log(`Row already exists: id=${existing[0].id} enabled=${existing[0].enabled}`);
  process.exit(0);
}

console.log(`Would insert watched_projects row for workspace=${workspaceId} repo=${repo}`);
if (!apply) {
  console.log('(dry run — re-run with --apply to write)');
  process.exit(0);
}

await sql`
  INSERT INTO watched_projects (workspace_id, repo, release_pr_filter, role_slug, pushover_app, enabled)
  VALUES (${workspaceId}, ${repo}, ${JSON.stringify(filter)}::jsonb, 'ops', 'alerts', true)
`;
console.log('Inserted.');
