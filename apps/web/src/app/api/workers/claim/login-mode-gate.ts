import { db } from '@buildd/core/db';
import { missions, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';

interface LoginModeCandidate {
  id: string;
  workspaceId: string;
  backend?: string | null;
  missionId?: string | null;
  roleSlug?: string | null;
  workspace?: { teamId?: string | null; gitConfig?: unknown } | null;
}

/**
 * The candidates stored on Claude because their mission, role or workspace
 * names Claude (spec 34a48877 R-16): a runner's login mode never moves them.
 * `tasks.backend` holds the resolved answer, so a task that fell through to the
 * schema default looks the same as one whose default said Claude; this asks the
 * defaults themselves, in two queries for the whole candidate window.
 */
export async function claudeDefaultTaskIds(candidates: LoginModeCandidate[]): Promise<Set<string>> {
  const tied = new Set<string>();
  const onClaude = candidates.filter(t => (t.backend ?? 'claude') === 'claude');
  if (onClaude.length === 0) return tied;

  for (const t of onClaude) {
    const ws = (t.workspace?.gitConfig ?? null) as { defaultBackend?: unknown } | null;
    if (ws?.defaultBackend === 'claude') tied.add(t.id);
  }

  const missionIds = [...new Set(onClaude.map(t => t.missionId).filter((id): id is string => !!id))];
  if (missionIds.length > 0) {
    const rows = await db.query.missions.findMany({
      where: sqlWhere(and(inArray(missions.id, missionIds), isNotNull(missions.defaultBackend))),
      columns: { id: true, defaultBackend: true },
    });
    const claudeMissions = new Set(rows.filter(r => r.defaultBackend === 'claude').map(r => r.id));
    for (const t of onClaude) if (t.missionId && claudeMissions.has(t.missionId)) tied.add(t.id);
  }

  const slugs = [...new Set(onClaude.map(t => t.roleSlug).filter((s): s is string => !!s))];
  if (slugs.length > 0) {
    const rows = await db.query.workspaceSkills.findMany({
      where: sqlWhere(and(
        inArray(workspaceSkills.slug, slugs),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        isNotNull(workspaceSkills.defaultBackend),
      )),
      columns: { slug: true, workspaceId: true, teamId: true, defaultBackend: true },
    });
    for (const t of onClaude) {
      if (!t.roleSlug) continue;
      // The task workspace's own row wins over the team's default row, as role routing resolves it.
      const own = rows.find(r => r.slug === t.roleSlug && r.workspaceId === t.workspaceId);
      const team = rows.find(r => r.slug === t.roleSlug && !r.workspaceId && r.teamId === t.workspace?.teamId);
      if ((own ?? team)?.defaultBackend === 'claude') tied.add(t.id);
    }
  }
  return tied;
}
