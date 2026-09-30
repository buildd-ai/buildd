/**
 * Seed for scripts/local-e2e.sh: one team, one open workspace, two API keys.
 *
 *   admin key   creates the task and sets the workspace webhook (what deploy.ts does)
 *   runner key  worker level, handed to the container (what the Worker holds)
 *
 * Writes only to the disposable local database: scripts/demo/lib/guard.ts
 * refuses to run unless DATABASE_URL and the Neon proxy are on loopback.
 * Prints `KEY=value` lines for the shell script to eval. Everything is synthetic.
 */
import '../../../scripts/demo/lib/guard';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalDb, schema as s } from '../../../packages/core/db/local-client';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// A tiny public repo, cloned over https with no token. The runner needs a repo
// to resolve the workspace; the task itself only asks for a one-word reply.
const REPO = process.env.CLOUD_E2E_REPO ?? 'octocat/Hello-World';
const BRANCH = process.env.CLOUD_E2E_BRANCH ?? 'master';

async function main() {
  const db = createLocalDb();
  const suffix = randomBytes(4).toString('hex');
  const adminKey = `bld_e2e_admin_${randomBytes(16).toString('hex')}`;
  const runnerKey = `bld_e2e_runner_${randomBytes(16).toString('hex')}`;

  const [team] = await db.insert(s.teams).values({ name: 'Cloud runner e2e', slug: `cloud-e2e-${suffix}` }).returning({ id: s.teams.id });
  const [admin] = await db.insert(s.accounts).values({
    type: 'service', level: 'admin', name: 'e2e-admin', apiKey: sha256(adminKey), apiKeyPrefix: adminKey.slice(0, 12),
    authType: 'api', teamId: team.id,
  } as any).returning({ id: s.accounts.id });
  const [runner] = await db.insert(s.accounts).values({
    type: 'service', level: 'worker', name: 'e2e-cloud-runner', apiKey: sha256(runnerKey), apiKeyPrefix: runnerKey.slice(0, 12),
    authType: 'api', teamId: team.id, maxConcurrentWorkers: 2,
  } as any).returning({ id: s.accounts.id });
  const [ws] = await db.insert(s.workspaces).values({
    name: `cloud-e2e-${suffix}`, repo: REPO, localPath: BRANCH, teamId: team.id, accessMode: 'open',
    // The runner branches worktrees off origin/<defaultBranch> (default main).
    gitConfig: { defaultBranch: BRANCH },
  } as any).returning({ id: s.workspaces.id });
  for (const accountId of [admin.id, runner.id]) {
    await db.insert(s.accountWorkspaces).values({ accountId, workspaceId: ws.id, canClaim: true, canCreate: true });
  }

  console.log(`E2E_TEAM_ID=${team.id}`);
  console.log(`E2E_WORKSPACE_ID=${ws.id}`);
  console.log(`E2E_ADMIN_KEY=${adminKey}`);
  console.log(`E2E_RUNNER_KEY=${runnerKey}`);
}

main().then(() => process.exit(0), (err) => {
  console.error(`[e2e-seed] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
