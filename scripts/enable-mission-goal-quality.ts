/**
 * Enable the mission_goal_quality capability for Max's team (buildd workspace).
 *
 * Usage:
 *   DATABASE_URL="…" bun run scripts/enable-mission-goal-quality.ts          # dry run
 *   DATABASE_URL="…" bun run scripts/enable-mission-goal-quality.ts --apply  # write
 */
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const sql = neon(DATABASE_URL);

// Find the buildd workspace and its team
const workspaces = (await sql`
  SELECT w.id, w.team_id, w.slug
  FROM workspaces w
  WHERE w.slug = 'buildd'
  LIMIT 1
`) as Array<{ id: string; team_id: string; slug: string }>;

if (workspaces.length === 0) {
  console.error('Buildd workspace not found');
  process.exit(1);
}

const workspace = workspaces[0];
const teamId = workspace.team_id;

console.log(`Found buildd workspace: id=${workspace.id}, team_id=${teamId}`);

// Get the current team configuration
const teams = (await sql`
  SELECT id, name, enabled_decision_shadows
  FROM teams
  WHERE id = ${teamId}
  LIMIT 1
`) as Array<{ id: string; name: string; enabled_decision_shadows: string[] | null }>;

if (teams.length === 0) {
  console.error(`Team ${teamId} not found`);
  process.exit(1);
}

const team = teams[0];
console.log(`Found team: id=${team.id}, name=${team.name}`);

// Check if mission_goal_quality is already enabled
const currentCapabilities = team.enabled_decision_shadows || [];
const hasCapability = currentCapabilities.includes('mission_goal_quality');

if (hasCapability) {
  console.log('mission_goal_quality is already enabled for this team');
  process.exit(0);
}

// Add the capability
const newCapabilities = [...currentCapabilities, 'mission_goal_quality'];

console.log(`Would add mission_goal_quality to enabledDecisionShadows`);
console.log(`  Current: ${JSON.stringify(currentCapabilities)}`);
console.log(`  New: ${JSON.stringify(newCapabilities)}`);

if (!apply) {
  console.log('(dry run — re-run with --apply to write)');
  process.exit(0);
}

// Update the team
await sql`
  UPDATE teams
  SET enabled_decision_shadows = ${JSON.stringify(newCapabilities)}::jsonb
  WHERE id = ${teamId}
`;

console.log('Updated.');
