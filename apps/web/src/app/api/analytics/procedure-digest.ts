import { PROCEDURE_MAX_STEPS } from '@buildd/core/procedure-skeleton';

/**
 * Workspace-scoped procedure digest (spec "Skill candidates, usage telemetry
 * and retirement" R-3). One row per verified task, carrying ONLY the short task
 * id, role slug, verified basis, the tool-name sequence (<= 40) and the
 * registered skill slugs the run loaded through the Skill tool. Titles,
 * summaries, paths, arguments and unregistered skill names never leave here.
 */
export type DigestWindow = '24h' | '7d' | '30d';

export interface DigestSourceRow {
  id: string;
  roleSlug: string | null;
  verifiedBasis: string;
  toolCalls: Array<{ name?: unknown }>;
  skillsLoaded: string[];
  [extra: string]: unknown;
}

export interface ProcedureDigestRow {
  taskId: string;
  roleSlug: string | null;
  verifiedBasis: string;
  tools: string[];
  skills: string[];
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export async function procedureDigest(opts: {
  workspaceId: string;
  callerWorkspaceIds: string[];
  window: DigestWindow;
  limit: number;
  load: (q: { workspaceId: string; window: DigestWindow; limit: number }) => Promise<DigestSourceRow[]>;
  registeredSkillSlugs: string[];
}): Promise<ProcedureDigestRow[]> {
  if (!opts.callerWorkspaceIds.includes(opts.workspaceId)) {
    throw new Error('forbidden: caller has no access to this workspace');
  }
  const limit = Math.max(1, Math.min(opts.limit, 200));
  const registered = new Set(opts.registeredSkillSlugs);
  const rows = await opts.load({ workspaceId: opts.workspaceId, window: opts.window, limit });
  return rows.slice(0, limit).map((r) => ({
    taskId: r.id.slice(0, 8),
    roleSlug: r.roleSlug,
    verifiedBasis: r.verifiedBasis,
    tools: r.toolCalls
      .map((c) => c?.name)
      .filter((n): n is string => typeof n === 'string' && NAME_RE.test(n))
      .slice(0, PROCEDURE_MAX_STEPS),
    skills: [...new Set(r.skillsLoaded.filter((s) => registered.has(s)))],
  }));
}
