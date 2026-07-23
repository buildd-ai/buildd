/**
 * Workspace migration — shared logic for the precheck / execute / repair routes.
 *
 * See docs/design/workspace-migration.md. The valuable, edge-case-heavy part is the
 * *classification* of every entity class into a disposition (MOVES_CLEANLY /
 * NEEDS_RE_ENTRY / NEEDS_RE_AUTH / WILL_BREAK / LEFT_BEHIND). That lives in the pure
 * `classifyMigration()` so it can be unit-tested without a database. DB access is
 * isolated in `collectMigrationSnapshot()`.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { db } from '@buildd/core/db';
import {
  workspaces, teams, missions, workspaceSkills, secrets, connectors,
  connectorWorkspaces, accountWorkspaces, accounts, taskSchedules, tasks, workers,
  artifacts, watchedProjects, oauthRefreshTokens, migrationLog,
} from '@buildd/core/db/schema';
import { eq, and, isNull, sql, inArray } from 'drizzle-orm';

// ─── Dispositions ────────────────────────────────────────────────────────────

export type EntityDisposition =
  | 'MOVES_CLEANLY'
  | 'NEEDS_RE_ENTRY'
  | 'NEEDS_RE_AUTH'
  | 'WILL_BREAK'
  | 'LEFT_BEHIND';

/** Dispositions whose items must be individually acknowledged before execute. */
export const ACK_REQUIRED: EntityDisposition[] = ['NEEDS_RE_ENTRY', 'NEEDS_RE_AUTH', 'WILL_BREAK'];

export interface DryRunItem {
  /** Stable key used for the confirmation gate (`confirmedItems`). */
  key: string;
  label: string;
  disposition: EntityDisposition;
}

export interface DryRunGroup {
  entity: string;
  disposition: EntityDisposition;
  count: number;
  detail?: string;
  items?: DryRunItem[];
}

export interface DryRunReport {
  workspaceId: string;
  workspaceName: string;
  sourceTeamId: string;
  sourceTeamName: string;
  destinationTeamId: string;
  destinationTeamName: string;
  generatedAt: string;
  precheck: {
    status: 'PASS' | 'FAIL';
    githubApp: { org: string | null; ok: boolean; message?: string };
  };
  /** Per-disposition tallies: item counts for actionable classes, group counts otherwise. */
  summary: Record<EntityDisposition, number>;
  groups: DryRunGroup[];
  /** Keys the execute endpoint requires in `confirmedItems` before it will proceed. */
  requiredAcks: string[];
}

// ─── Execution phases (BT-4…BT-10) ───────────────────────────────────────────

export const MIGRATION_PHASES = [
  'workspace_team',
  'missions_team',
  'skills_team',
  'clear_account_workspaces',
  'clear_connector_workspaces',
  'delete_secrets',
  'checklist_artifact',
] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

// ─── Dry-run token (HMAC, 5-minute TTL) ──────────────────────────────────────

const TOKEN_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

function signingSecret(): string {
  const s = process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('workspace-migration: no signing secret (ENCRYPTION_KEY) configured');
  return s;
}

/** `{issuedAt}.{hmac}` binding the workspace+destination pair to a fresh precheck. */
export function signDryRunToken(workspaceId: string, destinationTeamId: string, issuedAt: number): string {
  const sig = createHmac('sha256', signingSecret())
    .update(`${workspaceId}:${destinationTeamId}:${issuedAt}`)
    .digest('hex');
  return `${issuedAt}.${sig}`;
}

export function verifyDryRunToken(
  token: string,
  workspaceId: string,
  destinationTeamId: string,
  now: number,
): { valid: boolean; reason?: 'malformed' | 'tampered' | 'stale' | 'future' } {
  const dot = token.indexOf('.');
  if (dot <= 0) return { valid: false, reason: 'malformed' };
  const issuedRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const issuedAt = Number(issuedRaw);
  if (!sig || !Number.isFinite(issuedAt)) return { valid: false, reason: 'malformed' };

  const expected = createHmac('sha256', signingSecret())
    .update(`${workspaceId}:${destinationTeamId}:${issuedAt}`)
    .digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'tampered' };
  if (issuedAt > now + CLOCK_SKEW_MS) return { valid: false, reason: 'future' };
  if (now - issuedAt > TOKEN_TTL_MS) return { valid: false, reason: 'stale' };
  return { valid: true };
}

// ─── Snapshot (DB reads) ──────────────────────────────────────────────────────

const TERMINAL_WORKER_STATUSES = ['completed', 'failed', 'error', 'idle'];

export interface MigrationSnapshot {
  workspace: { id: string; name: string; teamId: string; githubInstallationId: string | null };
  sourceTeam: { id: string; name: string };
  destinationTeam: { id: string; name: string };
  counts: {
    tasks: number;
    workers: number;
    workersInFlight: number;
    artifacts: number;
    watchedProjects: number;
    oauthTokens: number;
    teamMissions: number;
    teamRoles: number;
  };
  schedules: Array<{ name: string; cronExpression: string }>;
  workspaceMissions: Array<{ id: string; title: string; status: string; dependsOnMissionId: string | null }>;
  workspaceRoles: Array<{ slug: string; name: string; canDelegateTo: string[] }>;
  destinationRoleSlugs: string[];
  workspaceSecrets: Array<{ purpose: string; label: string | null }>;
  connectors: Array<{ id: string; name: string; authMode: string }>;
  accountAccess: Array<{ accountId: string; name: string }>;
  githubInstalledInDestination: boolean;
}

async function count(table: any, where: any): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return row?.n ?? 0;
}

/** Reads every entity class the migration touches. Thin; the logic lives in classifyMigration. */
export async function collectMigrationSnapshot(
  workspaceId: string,
  destinationTeamId: string,
): Promise<MigrationSnapshot | null> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, name: true, teamId: true, githubInstallationId: true },
  });
  if (!workspace) return null;
  const sourceTeamId = workspace.teamId;

  const [sourceTeam, destinationTeam] = await Promise.all([
    db.query.teams.findFirst({ where: eq(teams.id, sourceTeamId), columns: { id: true, name: true } }),
    db.query.teams.findFirst({ where: eq(teams.id, destinationTeamId), columns: { id: true, name: true } }),
  ]);
  if (!destinationTeam) return null;

  const [
    tasksN, workersN, workersInFlightN, artifactsN, watchedN, oauthN, teamMissionsN, teamRolesN,
    scheduleRows, missionRows, roleRows, destRoleRows, secretRows, connectorRows, accountRows,
    ghDestWorkspace,
  ] = await Promise.all([
    count(tasks, eq(tasks.workspaceId, workspaceId)),
    count(workers, eq(workers.workspaceId, workspaceId)),
    count(workers, and(eq(workers.workspaceId, workspaceId), sql`${workers.status} not in ('completed','failed','error','idle')`)),
    count(artifacts, eq(artifacts.workspaceId, workspaceId)),
    count(watchedProjects, eq(watchedProjects.workspaceId, workspaceId)),
    count(oauthRefreshTokens, and(eq(oauthRefreshTokens.workspaceId, workspaceId), isNull(oauthRefreshTokens.revokedAt))),
    count(missions, and(eq(missions.teamId, sourceTeamId), isNull(missions.workspaceId))),
    count(workspaceSkills, and(eq(workspaceSkills.teamId, sourceTeamId), isNull(workspaceSkills.workspaceId))),
    db.query.taskSchedules.findMany({ where: eq(taskSchedules.workspaceId, workspaceId), columns: { name: true, cronExpression: true } }),
    db.query.missions.findMany({ where: eq(missions.workspaceId, workspaceId), columns: { id: true, title: true, status: true, dependsOnMissionId: true } }),
    db.query.workspaceSkills.findMany({ where: and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.isRole, true)), columns: { slug: true, name: true, canDelegateTo: true } }),
    db.query.workspaceSkills.findMany({ where: and(eq(workspaceSkills.teamId, destinationTeamId), isNull(workspaceSkills.workspaceId)), columns: { slug: true } }),
    db.query.secrets.findMany({ where: eq(secrets.workspaceId, workspaceId), columns: { purpose: true, label: true } }),
    db.select({ id: connectors.id, name: connectors.name, authMode: connectors.authMode })
      .from(connectorWorkspaces)
      .innerJoin(connectors, eq(connectors.id, connectorWorkspaces.connectorId))
      .where(eq(connectorWorkspaces.workspaceId, workspaceId)),
    db.select({ accountId: accounts.id, name: accounts.name })
      .from(accountWorkspaces)
      .innerJoin(accounts, eq(accounts.id, accountWorkspaces.accountId))
      .where(eq(accountWorkspaces.workspaceId, workspaceId)),
    workspace.githubInstallationId
      ? db.query.workspaces.findFirst({
          where: and(eq(workspaces.teamId, destinationTeamId), eq(workspaces.githubInstallationId, workspace.githubInstallationId)),
          columns: { id: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    workspace: { id: workspace.id, name: workspace.name, teamId: sourceTeamId, githubInstallationId: workspace.githubInstallationId ?? null },
    sourceTeam: { id: sourceTeamId, name: sourceTeam?.name ?? '(source team)' },
    destinationTeam: { id: destinationTeam.id, name: destinationTeam.name },
    counts: {
      tasks: tasksN, workers: workersN, workersInFlight: workersInFlightN, artifacts: artifactsN,
      watchedProjects: watchedN, oauthTokens: oauthN, teamMissions: teamMissionsN, teamRoles: teamRolesN,
    },
    schedules: scheduleRows as any,
    workspaceMissions: missionRows as any,
    workspaceRoles: roleRows.map((r: any) => ({ slug: r.slug, name: r.name, canDelegateTo: r.canDelegateTo ?? [] })),
    destinationRoleSlugs: destRoleRows.map((r: any) => r.slug),
    workspaceSecrets: secretRows as any,
    connectors: connectorRows.map((c: any) => ({ id: c.id, name: c.name, authMode: c.authMode })),
    accountAccess: accountRows as any,
    githubInstalledInDestination: !!ghDestWorkspace,
  };
}

// ─── Pure classification ──────────────────────────────────────────────────────

const EMPTY_SUMMARY = (): Record<EntityDisposition, number> => ({
  MOVES_CLEANLY: 0, NEEDS_RE_ENTRY: 0, NEEDS_RE_AUTH: 0, WILL_BREAK: 0, LEFT_BEHIND: 0,
});

export function classifyMigration(snap: MigrationSnapshot, generatedAt: string): DryRunReport {
  const groups: DryRunGroup[] = [];

  // Clean movers (FK-stable on the unchanged workspace UUID).
  groups.push({ entity: 'Tasks', disposition: 'MOVES_CLEANLY', count: snap.counts.tasks });
  groups.push({ entity: 'Workers', disposition: 'MOVES_CLEANLY', count: snap.counts.workers, detail: `${snap.counts.workersInFlight} in-flight` });
  groups.push({ entity: 'Artifacts', disposition: 'MOVES_CLEANLY', count: snap.counts.artifacts });
  groups.push({
    entity: 'Task Schedules', disposition: 'MOVES_CLEANLY', count: snap.schedules.length,
    detail: snap.schedules.map((s) => `"${s.name}" (${s.cronExpression})`).join('; ') || undefined,
  });
  groups.push({ entity: 'Watched Projects', disposition: 'MOVES_CLEANLY', count: snap.counts.watchedProjects });
  groups.push({ entity: 'OAuth MCP tokens', disposition: 'MOVES_CLEANLY', count: snap.counts.oauthTokens, detail: 'active client sessions remain valid' });
  groups.push({ entity: 'Knowledge (DB corpora)', disposition: 'MOVES_CLEANLY', count: 0, detail: 'code/docs/spec/task/plan namespaces unchanged (workspace UUID stable)' });

  // Missions (workspace-linked) — clean, but audit dependsOnMission chains that stay behind.
  // A dependency "stays behind" when its target is not itself a moving (workspace-linked) mission.
  const movingMissionIds = new Set(snap.workspaceMissions.map((m) => m.id));
  const brokenDeps: DryRunItem[] = [];
  for (const m of snap.workspaceMissions) {
    if (m.dependsOnMissionId && !movingMissionIds.has(m.dependsOnMissionId)) {
      brokenDeps.push({
        key: `mission-dep:${m.id}`,
        label: `Mission "${m.title}" dependsOnMission stays in source team → gate WILL BREAK`,
        disposition: 'WILL_BREAK',
      });
    }
  }
  groups.push({ entity: 'Missions (workspace-linked)', disposition: 'MOVES_CLEANLY', count: snap.workspaceMissions.length });
  if (brokenDeps.length) {
    groups.push({ entity: 'Mission dependency chains', disposition: 'WILL_BREAK', count: brokenDeps.length, items: brokenDeps });
  }

  // Roles (workspace-scoped) — clean move; audit canDelegateTo against destination registry.
  // Default roles (Organizer/Builder/Researcher) are seeded into every team, so they always
  // resolve in the destination even if the destination has no explicit row for them yet.
  const DEFAULT_ROLE_SLUGS = ['organizer', 'builder', 'researcher'];
  const destRoles = new Set([...snap.destinationRoleSlugs, ...DEFAULT_ROLE_SLUGS]);
  const brokenDelegations: DryRunItem[] = [];
  for (const role of snap.workspaceRoles) {
    for (const target of role.canDelegateTo) {
      if (!destRoles.has(target)) {
        brokenDelegations.push({
          key: `delegation:${role.slug}->${target}`,
          label: `Role "${role.name}" canDelegateTo "${target}" — slug not found in destination team`,
          disposition: 'WILL_BREAK',
        });
      }
    }
  }
  groups.push({ entity: 'Roles (workspace-scoped)', disposition: 'MOVES_CLEANLY', count: snap.workspaceRoles.length });
  if (brokenDelegations.length) {
    groups.push({ entity: 'Role delegation chains', disposition: 'WILL_BREAK', count: brokenDelegations.length, items: brokenDelegations });
  }

  // Secrets (workspace-scoped) — deleted at migration; must be re-entered.
  if (snap.workspaceSecrets.length) {
    groups.push({
      entity: 'Secrets (workspace-scoped)', disposition: 'NEEDS_RE_ENTRY', count: snap.workspaceSecrets.length,
      detail: 'deleted at migration — re-enter in destination team',
      items: snap.workspaceSecrets.map((s) => ({
        key: `secret:${s.purpose}:${s.label ?? ''}`,
        label: `${s.purpose} "${s.label ?? '(unlabeled)'}"`,
        disposition: 'NEEDS_RE_ENTRY',
      })),
    });
  }

  // Connectors — enablement rows deleted; re-authorize in destination team.
  if (snap.connectors.length) {
    groups.push({
      entity: 'Connectors', disposition: 'NEEDS_RE_AUTH', count: snap.connectors.length,
      detail: 'connector_workspaces rows deleted — re-add in destination team',
      items: snap.connectors.map((c) => ({
        key: `connector:${c.id}`,
        label: `"${c.name}" (${c.authMode})${c.authMode === 'none' ? ' — re-add, no re-auth needed' : ''}`,
        disposition: 'NEEDS_RE_AUTH',
      })),
    });
  }

  // Account access — source-team runner accounts removed.
  if (snap.accountAccess.length) {
    groups.push({
      entity: 'Account Access', disposition: 'WILL_BREAK', count: snap.accountAccess.length,
      detail: 'source-team accounts removed — add destination-team accounts post-migration',
      items: snap.accountAccess.map((a) => ({
        key: `account:${a.accountId}`,
        label: `Runner account "${a.name}" access removed`,
        disposition: 'WILL_BREAK',
      })),
    });
  }

  // Left behind (source team retains).
  if (snap.counts.teamMissions) {
    groups.push({ entity: 'Missions (team-level)', disposition: 'LEFT_BEHIND', count: snap.counts.teamMissions, detail: 'team missions stay in source team' });
  }
  if (snap.counts.teamRoles) {
    groups.push({ entity: 'Roles (team-level)', disposition: 'LEFT_BEHIND', count: snap.counts.teamRoles, detail: 'shared roles stay in source team' });
  }
  groups.push({ entity: 'Knowledge (memory corpus)', disposition: 'LEFT_BEHIND', count: 0, detail: `${snap.sourceTeam.id}:memory stays in source team namespace` });

  // GitHub App precheck.
  const org = snap.workspace.githubInstallationId ? 'linked installation' : null;
  const ghOk = !snap.workspace.githubInstallationId || snap.githubInstalledInDestination;
  groups.push({
    entity: 'GitHub App', disposition: 'MOVES_CLEANLY',
    count: snap.workspace.githubInstallationId ? 1 : 0,
    detail: ghOk ? 'destination team has installation' : 'destination team missing installation',
  });

  // Summary: item counts for actionable classes, group counts otherwise.
  const summary = EMPTY_SUMMARY();
  for (const g of groups) {
    if (ACK_REQUIRED.includes(g.disposition)) {
      summary[g.disposition] += g.items?.length ?? g.count;
    } else {
      summary[g.disposition] += 1;
    }
  }

  const requiredAcks = groups
    .flatMap((g) => g.items ?? [])
    .filter((i) => ACK_REQUIRED.includes(i.disposition))
    .map((i) => i.key);

  return {
    workspaceId: snap.workspace.id,
    workspaceName: snap.workspace.name,
    sourceTeamId: snap.sourceTeam.id,
    sourceTeamName: snap.sourceTeam.name,
    destinationTeamId: snap.destinationTeam.id,
    destinationTeamName: snap.destinationTeam.name,
    generatedAt,
    precheck: {
      status: ghOk ? 'PASS' : 'FAIL',
      githubApp: {
        org,
        ok: ghOk,
        message: ghOk ? undefined : `Migration blocked: destination team missing the GitHub App on ${org}. Install at github.com/apps/buildd and authorize the org, then retry.`,
      },
    },
    summary,
    groups,
    requiredAcks,
  };
}

// ─── Post-migration checklist ─────────────────────────────────────────────────

export function renderChecklistMarkdown(report: DryRunReport, migratedAt: string): string {
  const req: string[] = [];
  for (const g of report.groups) {
    for (const item of g.items ?? []) {
      if (item.disposition === 'NEEDS_RE_ENTRY') req.push(`- [ ] Re-enter secret: ${item.label} (workspace settings → Secrets)`);
      else if (item.disposition === 'NEEDS_RE_AUTH') req.push(`- [ ] Re-add/re-authorize connector ${item.label} in destination team → Connections`);
      else if (item.disposition === 'WILL_BREAK' && item.key.startsWith('account:')) req.push(`- [ ] Add runner account access: ${item.label} (workspace settings → Access)`);
      else if (item.disposition === 'WILL_BREAK') req.push(`- [ ] Resolve breakage: ${item.label}`);
    }
  }
  // Service/machine-account handoff: always surface the API-key rotation for externally-dispatched workspaces.
  req.push('- [ ] If this workspace is dispatched to by an external caller, issue a destination-team admin API key and update the caller\'s BUILDD_API_ADMIN_KEY');

  const clean = report.groups.filter((g) => g.disposition === 'MOVES_CLEANLY' && g.count > 0);
  return [
    `# Post-Migration Checklist: ${report.workspaceName}`,
    `Migrated: ${report.sourceTeamName} → ${report.destinationTeamName}`,
    `Date: ${migratedAt}`,
    '',
    '## Required actions',
    '',
    req.join('\n') || '- (none)',
    '',
    '## Completed automatically',
    '',
    ...clean.map((g) => `- ✓ ${g.entity}: ${g.count}${g.detail ? ` — ${g.detail}` : ''}`),
  ].join('\n');
}

// ─── Phased execution (BT-3…BT-10) ────────────────────────────────────────────

export class MigrationPhaseError extends Error {
  constructor(public phase: MigrationPhase, public cause: unknown) {
    super(`workspace migration failed at phase "${phase}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationPhaseError';
  }
}

export interface PhaseOutcome {
  phase: MigrationPhase;
  status: 'completed' | 'skipped';
  detail: Record<string, unknown>;
}

export interface ExecuteMigrationOpts {
  runId: string;
  workspaceId: string;
  sourceTeamId: string;
  destinationTeamId: string;
  report: DryRunReport;
  migratedAt: string;
}

/** Mission ids whose dependsOn target stays behind (from the report), to sever the FK. */
function brokenDepMissionIds(report: DryRunReport): string[] {
  return report.requiredAcks
    .filter((k) => k.startsWith('mission-dep:'))
    .map((k) => k.slice('mission-dep:'.length));
}

async function markPhase(
  opts: ExecuteMigrationOpts,
  phase: MigrationPhase,
  status: 'pending' | 'completed' | 'failed',
  extra: { detail?: Record<string, unknown>; error?: string } = {},
) {
  if (status === 'pending') {
    await db.insert(migrationLog)
      .values({
        runId: opts.runId, workspaceId: opts.workspaceId, sourceTeamId: opts.sourceTeamId,
        destinationTeamId: opts.destinationTeamId, phase, status: 'pending', error: null,
        detail: extra.detail ?? {}, completedAt: null,
      })
      .onConflictDoUpdate({
        target: [migrationLog.runId, migrationLog.phase],
        set: { status: 'pending', error: null, detail: extra.detail ?? {}, startedAt: new Date(), completedAt: null },
      });
    return;
  }
  await db.update(migrationLog)
    .set({ status, error: extra.error ?? null, detail: extra.detail ?? {}, completedAt: status === 'completed' ? new Date() : null })
    .where(and(eq(migrationLog.runId, opts.runId), eq(migrationLog.phase, phase)));
}

/** Runs the actual DB mutation for a phase, returning a detail object for the ledger/checklist. */
async function runPhaseWork(opts: ExecuteMigrationOpts, phase: MigrationPhase): Promise<Record<string, unknown>> {
  const { workspaceId, sourceTeamId, destinationTeamId, report } = opts;
  switch (phase) {
    case 'workspace_team': {
      const moved = await db.update(workspaces)
        .set({ teamId: destinationTeamId, updatedAt: new Date() })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.teamId, sourceTeamId)))
        .returning({ id: workspaces.id });
      if (moved.length === 0) {
        // Idempotent: fine if already at destination (repair / retry); else a concurrent move won.
        const current = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } });
        if (current?.teamId !== destinationTeamId) throw new Error('workspace_team_conflict');
        return { alreadyMoved: true };
      }
      return { moved: true };
    }
    case 'missions_team': {
      await db.update(missions)
        .set({ teamId: destinationTeamId })
        .where(and(eq(missions.workspaceId, workspaceId), eq(missions.teamId, sourceTeamId)));
      const brokenIds = brokenDepMissionIds(report);
      if (brokenIds.length) {
        await db.update(missions).set({ dependsOnMissionId: null }).where(inArray(missions.id, brokenIds));
      }
      return { severedDeps: brokenIds };
    }
    case 'skills_team': {
      await db.update(workspaceSkills)
        .set({ teamId: destinationTeamId })
        .where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.teamId, sourceTeamId)));
      return {};
    }
    case 'clear_account_workspaces': {
      const names = report.groups.find((g) => g.entity === 'Account Access')?.items?.map((i) => i.label) ?? [];
      await db.delete(accountWorkspaces).where(eq(accountWorkspaces.workspaceId, workspaceId));
      return { removedAccounts: names };
    }
    case 'clear_connector_workspaces': {
      const names = report.groups.find((g) => g.entity === 'Connectors')?.items?.map((i) => i.label) ?? [];
      await db.delete(connectorWorkspaces).where(eq(connectorWorkspaces.workspaceId, workspaceId));
      return { removedConnectors: names };
    }
    case 'delete_secrets': {
      const labels = report.groups.find((g) => g.entity === 'Secrets (workspace-scoped)')?.items?.map((i) => i.label) ?? [];
      await db.delete(secrets).where(eq(secrets.workspaceId, workspaceId));
      return { deletedSecrets: labels };
    }
    case 'checklist_artifact': {
      const content = renderChecklistMarkdown(report, opts.migratedAt);
      const [row] = await db.insert(artifacts).values({
        workspaceId,
        type: 'report',
        title: `Post-Migration Checklist → ${report.destinationTeamName}`,
        content,
        metadata: { kind: 'workspace-migration-checklist', runId: opts.runId, destinationTeamId },
      }).returning({ id: artifacts.id });
      return { checklistArtifactId: row?.id };
    }
  }
}

/**
 * Runs all migration phases in the safe order (identity moves before destructive deletes).
 * Each phase is idempotent via the `migration_log` (runId, phase) ledger — a phase already
 * marked `completed` for this run is skipped, so the repair endpoint can resume a failed run.
 * Throws MigrationPhaseError on the first failure (steps before it stay applied).
 */
export async function executeMigrationPhases(opts: ExecuteMigrationOpts): Promise<{
  outcomes: PhaseOutcome[];
  checklistArtifactId?: string;
}> {
  const outcomes: PhaseOutcome[] = [];
  let checklistArtifactId: string | undefined;

  for (const phase of MIGRATION_PHASES) {
    const existing = await db.query.migrationLog.findFirst({
      where: and(eq(migrationLog.runId, opts.runId), eq(migrationLog.phase, phase)),
      columns: { status: true, detail: true },
    });
    if (existing?.status === 'completed') {
      outcomes.push({ phase, status: 'skipped', detail: (existing.detail as Record<string, unknown>) ?? {} });
      if (phase === 'checklist_artifact') checklistArtifactId = (existing.detail as any)?.checklistArtifactId;
      continue;
    }

    await markPhase(opts, phase, 'pending');
    try {
      const detail = await runPhaseWork(opts, phase);
      await markPhase(opts, phase, 'completed', { detail });
      outcomes.push({ phase, status: 'completed', detail });
      if (phase === 'checklist_artifact') checklistArtifactId = detail.checklistArtifactId as string | undefined;
    } catch (err) {
      await markPhase(opts, phase, 'failed', { error: err instanceof Error ? err.message : String(err) });
      throw new MigrationPhaseError(phase, err);
    }
  }

  return { outcomes, checklistArtifactId };
}
