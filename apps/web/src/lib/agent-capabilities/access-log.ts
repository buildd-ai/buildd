/**
 * Read agent_capability_decisions back as plain language: what a run was
 * given, what it was refused and why. One shape for every surface — the task
 * page's Access section, Health's Agent access card, and `explain`.
 *
 * Rows never hold credentials, and neither does anything here: resources are
 * shown as a repo's name or a PR number, never an internal row id.
 */
import { db } from '@buildd/core/db';
import { agentCapabilityDecisions, githubRepos, workspaces } from '@buildd/core/db/schema';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';

export interface CapabilityRow {
  occurredAt: Date;
  workspaceId: string | null;
  workerId: string | null;
  capability: string;
  decision: 'allowed' | 'refused' | string;
  resource: string | null;
  reasonCode: string | null;
  expiresAt: Date | null;
  sideEffect: Record<string, unknown> | null;
}

export interface AccessItem {
  at: string;
  /** Last occurrence when repeats were folded into this item. */
  lastAt: string;
  count: number;
  capability: string;
  label: string;
  decision: 'allowed' | 'refused';
  /** Plain words for a refusal (or a notable allowance, e.g. admin level); null when there is nothing to say. */
  reason: string | null;
  /** What it was about: a repo name, "PR #42", "this task". */
  target: string | null;
  expiresAt: string | null;
  workerId: string | null;
}

const LABEL: Record<string, string> = {
  'github.repo_grant': 'GitHub repo access',
  'model.endpoint': 'Model endpoint',
  'task_token.mint': 'buildd token',
  'runner.size': 'Runner size',
  'pr.create': 'Open PR',
  'pr.adopt': 'Record PR',
  'pr.close': 'Close PR',
  'pr.update_body': 'Update PR body',
  'pr.merge': 'Merge PR',
};

const REASON: Record<string, string> = {
  not_found: 'not reachable with this key',
  dispatch_token_mismatch: 'dispatch token did not match the workspace',
  no_live_worker: 'the run was not live',
  worker_not_live: 'the run was not live',
  no_linked_repo: 'the workspace has no linked GitHub repo',
  installation_suspended: 'the GitHub App installation is suspended',
  mint_failed: 'GitHub would not issue a token',
  head_not_owned: "not this task's branch",
  protected_head: 'a protected branch',
  pr_outside_linked_repo: "not in this workspace's repo",
  pr_unreadable: 'the PR could not be read',
  mission_base: "the wrong base for this task's mission",
  pr_not_owned: "not this task's PR",
  merge_failed: 'the merge did not go through',
  admin_not_orchestration: 'admin level is only for organizer, planning and check-in tasks',
  admin_no_repo_workspace: 'admin level needs a workspace with a repo',
  admin_level: 'admin level',
};

/** Plain words for a reason code; an unknown code is shown with its underscores as spaces. */
export function reasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON[code] ?? code.replace(/_/g, ' ');
}

function targetText(row: CapabilityRow, repoNames: ReadonlyMap<string, string>): string | null {
  const r = row.resource ?? '';
  if (r.startsWith('github_repo:')) return repoNames.get(r.slice('github_repo:'.length)) ?? 'linked repo';
  if (r.startsWith('pr:')) return `PR #${r.slice(3)}`;
  if (row.capability === 'task_token.mint') return row.reasonCode === 'admin_level' ? 'admin level' : 'worker level';
  if (r === 'anthropic_api_key') return "the team's Anthropic key";
  if (r.startsWith('agent_endpoint:')) return `${r.slice('agent_endpoint:'.length)} endpoint`;
  return null;
}

/**
 * Rows → items, oldest first. Consecutive allowances of the same thing (a
 * token renewed every hour) fold into one item with a count; refusals never
 * fold, each one is something to read.
 */
export function summarizeAccess(rows: readonly CapabilityRow[], repoNames: ReadonlyMap<string, string> = new Map()): AccessItem[] {
  const out: AccessItem[] = [];
  for (const row of [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const decision = row.decision === 'refused' ? 'refused' : 'allowed';
    const target = targetText(row, repoNames);
    const reason = decision === 'refused' || row.reasonCode === 'admin_level' ? reasonText(row.reasonCode) : null;
    const prev = out[out.length - 1];
    if (prev && decision === 'allowed' && prev.decision === 'allowed' && prev.capability === row.capability && prev.target === target && prev.workerId === row.workerId) {
      prev.count += 1;
      prev.lastAt = row.occurredAt.toISOString();
      prev.expiresAt = row.expiresAt?.toISOString() ?? prev.expiresAt;
      continue;
    }
    out.push({
      at: row.occurredAt.toISOString(),
      lastAt: row.occurredAt.toISOString(),
      count: 1,
      capability: row.capability,
      label: LABEL[row.capability] ?? row.capability,
      decision,
      reason,
      target,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      workerId: row.workerId,
    });
  }
  return out;
}

async function repoNamesFor(rows: readonly CapabilityRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(r => r.resource ?? '').filter(r => r.startsWith('github_repo:')).map(r => r.slice('github_repo:'.length)))];
  if (ids.length === 0) return new Map();
  const repos = await db.query.githubRepos.findMany({ where: inArray(githubRepos.id, ids), columns: { id: true, fullName: true } });
  return new Map(repos.map(r => [r.id, r.fullName]));
}

const ROW_COLUMNS = {
  occurredAt: true, workspaceId: true, workerId: true, capability: true, decision: true,
  resource: true, reasonCode: true, expiresAt: true, sideEffect: true,
} as const;

/** A task's access timeline, oldest first. */
export async function loadTaskAccess(taskId: string, limit = 300): Promise<AccessItem[]> {
  const rows = await db.query.agentCapabilityDecisions.findMany({
    where: eq(agentCapabilityDecisions.taskId, taskId),
    orderBy: [asc(agentCapabilityDecisions.occurredAt)],
    limit,
    columns: ROW_COLUMNS,
  }) as CapabilityRow[];
  return summarizeAccess(rows, await repoNamesFor(rows));
}

// ─── Health ────────────────────────────────────────────────────────────────

/** The grants a run needs to start; their refusals are setup problems, not agent behaviour. */
const GRANT_CAPABILITIES = new Set(['github.repo_grant', 'model.endpoint', 'task_token.mint']);

/** Grant refusals that point at something a person should fix, with the fix. */
const FIX: Record<string, string> = {
  no_linked_repo: 'Link a GitHub repo to the workspace.',
  installation_suspended: 'Unsuspend the GitHub App installation for this repo.',
  mint_failed: 'Check the GitHub App installation and its permissions on this repo.',
  dispatch_token_mismatch: "The cloud runner's dispatch token does not match the workspace; re-save the workspace's runner settings.",
};

export interface AgentAccessReport {
  windowHours: number;
  granted: number;
  adminGranted: number;
  /** Grant refusals a person can fix, by workspace and cause. */
  grantProblems: Array<{ workspaceId: string; workspaceName: string; reason: string; fix: string | null; count: number; lastAt: string }>;
  /** Actions agents were refused (reaching outside their task), by what and why. */
  refusals: Array<{ label: string; reason: string; count: number }>;
  healthy: boolean;
}

export function buildAgentAccessReport(
  rows: readonly CapabilityRow[],
  workspaceNames: ReadonlyMap<string, string>,
  windowHours: number,
): AgentAccessReport {
  let granted = 0;
  let adminGranted = 0;
  const problems = new Map<string, AgentAccessReport['grantProblems'][number]>();
  const refusals = new Map<string, AgentAccessReport['refusals'][number]>();
  for (const r of rows) {
    if (r.decision !== 'refused') {
      if (GRANT_CAPABILITIES.has(r.capability)) granted++;
      if (r.reasonCode === 'admin_level') adminGranted++;
      continue;
    }
    if (GRANT_CAPABILITIES.has(r.capability) && r.reasonCode && FIX[r.reasonCode] && r.workspaceId) {
      const key = `${r.workspaceId}|${r.reasonCode}`;
      const at = r.occurredAt.toISOString();
      const cur = problems.get(key);
      if (cur) { cur.count++; if (at > cur.lastAt) cur.lastAt = at; }
      else problems.set(key, { workspaceId: r.workspaceId, workspaceName: workspaceNames.get(r.workspaceId) ?? 'a workspace', reason: reasonText(r.reasonCode)!, fix: FIX[r.reasonCode] ?? null, count: 1, lastAt: at });
      continue;
    }
    if (GRANT_CAPABILITIES.has(r.capability)) continue;
    const label = LABEL[r.capability] ?? r.capability;
    const reason = reasonText(r.reasonCode) ?? 'refused';
    const key = `${label}|${reason}`;
    const cur = refusals.get(key);
    if (cur) cur.count++;
    else refusals.set(key, { label, reason, count: 1 });
  }
  const grantProblems = [...problems.values()].sort((a, b) => b.count - a.count);
  return {
    windowHours,
    granted,
    adminGranted,
    grantProblems,
    refusals: [...refusals.values()].sort((a, b) => b.count - a.count),
    healthy: grantProblems.length === 0,
  };
}

/** The Agent access report for these workspaces over the last `windowHours`. */
export async function loadAgentAccessReport(workspaceIds: readonly string[], windowHours = 24): Promise<AgentAccessReport | null> {
  if (workspaceIds.length === 0) return null;
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await db.query.agentCapabilityDecisions.findMany({
    where: and(inArray(agentCapabilityDecisions.workspaceId, [...workspaceIds]), gte(agentCapabilityDecisions.occurredAt, since)),
    orderBy: [desc(agentCapabilityDecisions.occurredAt)],
    limit: 5000,
    columns: ROW_COLUMNS,
  }) as CapabilityRow[];
  if (rows.length === 0) return null;
  const wsIds = [...new Set(rows.map(r => r.workspaceId).filter((w): w is string => !!w))];
  const names = wsIds.length > 0
    ? await db.query.workspaces.findMany({ where: inArray(workspaces.id, wsIds), columns: { id: true, name: true } })
    : [];
  return buildAgentAccessReport(rows, new Map(names.map(w => [w.id, w.name])), windowHours);
}
