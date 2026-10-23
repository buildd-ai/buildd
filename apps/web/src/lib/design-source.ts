import { db } from '@buildd/core/db';
import { artifacts, missions, specCriterionRecords, specRevisions } from '@buildd/core/db/schema';
import { asc, eq } from 'drizzle-orm';
import { criterionScreens, designSourceFromContext, pickDesign, type DesignCriterion, type DesignScreenInfo, type DesignSource } from '@buildd/shared';
import { artifactsLinkedTo } from '@/lib/artifact-links';
import { isUuid } from '@/lib/uuid';

/**
 * The design a builder gets, resolved at claim so nobody has to write it into
 * the description ("Designs in buildd" R-10): the task's own `design_reference`
 * link, else its mission's, else the design pinned on the spec revision the
 * task (or its mission) builds. A link reads at its pinned revision, else the
 * artifact's current one; a spec pin is always a fixed revision. The screens
 * that matter are the ones the spec's criteria name in `screen:` lines,
 * narrowed to the criteria the task answers for.
 *
 * Returns the `context.designSource` the claim sends, or null to leave the
 * context as it is: nothing is attached, or the filer already named a design
 * artifact. The claude.ai and copy-in forms the filer wrote are kept beside the
 * resolved artifact; the prompt reads the artifact first.
 */

type Link = { artifactId: string; pinnedRevision: number | null; currentRevision: number };
type SpecPin = { specRevisionId: string; criteria?: string[] };

export interface DesignSourceDeps {
  designLinks(kind: 'task' | 'mission', id: string): Promise<Link[]>;
  /** The mission's outcome spec pin, when it has one. */
  missionSpecPin(missionId: string): Promise<SpecPin | null>;
  /** The screens the design file declares (artifact metadata). Optional: absent, the context carries ids only. */
  designScreens?(artifactId: string): Promise<DesignScreenInfo[]>;
  specRevision(specRevisionId: string): Promise<{ design: unknown; criteria: DesignCriterion[] } | null>;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const scopeOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

function taskSpecPin(context: Record<string, unknown> | null): SpecPin | null {
  const src = asRecord(context?.specSource);
  if (typeof src?.specRevisionId !== 'string' || !isUuid(src.specRevisionId)) return null;
  return { specRevisionId: src.specRevisionId, criteria: scopeOf(src.criteria) };
}

const fromLink = (links: Link[]) => {
  const l = links[0];
  return l ? { artifactId: l.artifactId, revision: l.pinnedRevision ?? l.currentRevision } : null;
};

function fromSpecDesign(design: unknown) {
  const d = asRecord(design);
  if (d?.kind !== 'artifact' || typeof d.ref !== 'string' || !isUuid(d.ref)) return null;
  const revision = Number(d.version);
  return { artifactId: d.ref, ...(Number.isInteger(revision) && revision > 0 ? { revision } : {}) };
}

export const designSourceDeps: DesignSourceDeps = {
  async designLinks(kind, id) {
    const linked = await artifactsLinkedTo(kind, id, { relations: ['design_reference'] });
    return Array.isArray(linked) ? linked : [];
  },
  async missionSpecPin(missionId) {
    const [m] = await db.select({ goalCriteria: missions.goalCriteria }).from(missions).where(eq(missions.id, missionId)).limit(1);
    const pin = (Array.isArray(m?.goalCriteria) ? m.goalCriteria : [])
      .map(asRecord)
      // A workspace standard (role 'standard', Living Specs D-43) is not the spec the mission builds.
      .find((c) => c?.type === 'living_spec' && c.role !== 'standard' && typeof c.specRevisionId === 'string');
    return pin ? { specRevisionId: pin.specRevisionId as string, criteria: scopeOf(pin.criteria) } : null;
  },
  async designScreens(artifactId) {
    const [a] = await db.select({ metadata: artifacts.metadata }).from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
    const raw = (a?.metadata as { screens?: unknown } | null)?.screens;
    return (Array.isArray(raw) ? raw : []).filter((s): s is DesignScreenInfo =>
      !!s && typeof s === 'object' && typeof (s as DesignScreenInfo).id === 'string' && typeof (s as DesignScreenInfo).name === 'string' && typeof (s as DesignScreenInfo).viewport === 'string');
  },
  async specRevision(specRevisionId) {
    const [rev] = await db.select({ design: specRevisions.design }).from(specRevisions).where(eq(specRevisions.id, specRevisionId)).limit(1);
    if (!rev) return null;
    const rows = await db.select({ id: specCriterionRecords.criterionId, screens: specCriterionRecords.screens })
      .from(specCriterionRecords).where(eq(specCriterionRecords.specRevisionId, specRevisionId)).orderBy(asc(specCriterionRecords.position));
    return { design: rev.design, criteria: rows.map((r) => ({ id: r.id, screens: Array.isArray(r.screens) ? r.screens : [] })) };
  },
};

export async function resolveDesignSourceAtClaim(
  task: { id: string; missionId?: string | null; context: unknown },
  deps: DesignSourceDeps = designSourceDeps,
): Promise<DesignSource | null> {
  const context = asRecord(task.context);
  const filed = designSourceFromContext(context);
  if (filed?.artifactId) return null;

  const taskDesign = fromLink(await deps.designLinks('task', task.id));
  const missionDesign = !taskDesign && task.missionId ? fromLink(await deps.designLinks('mission', task.missionId)) : null;
  const pin = taskSpecPin(context) ?? (task.missionId ? await deps.missionSpecPin(task.missionId) : null);
  const spec = pin ? await deps.specRevision(pin.specRevisionId) : null;

  const picked = pickDesign({ taskDesign, missionDesign, specDesign: spec ? fromSpecDesign(spec.design) : null });
  if (!picked) return null;

  const criteria = (spec?.criteria ?? [])
    .filter((c) => !pin?.criteria || pin.criteria.includes(c.id))
    .filter((c) => c.screens.length > 0);
  const matter = criteria.length > 0 ? criterionScreens(criteria) : [];
  const screenInfo = await deps.designScreens?.(picked.artifactId).catch(() => [] as DesignScreenInfo[]) ?? [];
  const named = matter.length > 0 ? screenInfo.filter((s) => matter.includes(s.id)) : screenInfo;
  return {
    ...(filed ?? {}),
    ...picked,
    ...(criteria.length > 0 ? { screens: matter, criteria } : {}),
    ...(named.length > 0 ? { screenInfo: named } : {}),
  };
}
