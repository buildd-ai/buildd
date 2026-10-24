/**
 * Claim-time spec criteria for a `[surface audit]` task (docs/specs/living-specs.md
 * §11). For each task the audit depends on that is pinned to a Living Spec,
 * the criteria that task answers for, read from its pinned revision, and how
 * to record a visual verdict on each. Computed at claim, like the required
 * routes, because the audit's dependencies grow after it is filed.
 * Best-effort: a failure attaches nothing, and the audit runs as before.
 */
import type { ClaimTasksResponse, DesignScreenInfo } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { loadDesignScreenInfo } from '@/lib/designs/screen-info';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { criterionScreens } from '@buildd/spec-contract/check-lines';
import { criterionVerificationScenarios } from '@buildd/spec-contract/verification-bindings';
import { inScope } from '@buildd/spec-contract/scope';
import { readPinnedSpecRevision } from '@/lib/specs/pin';
import { MAX_VISUAL_SHOTS } from '@/lib/specs/visual-limits';
import { appendContextBlock } from './context-injection';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY = 'visualAuditSpecCriteria';
/** The design the audit compares against: `{ artifactId, revision, from: 'mission' | 'spec' }`. */
export const VISUAL_AUDIT_DESIGN_CONTEXT_KEY = 'visualAuditDesign';

type AuditTask = { id: string; roleSlug?: string | null; dependsOn?: unknown; missionId?: string | null };

/** A buildd design artifact at one revision: the mission's `design_reference` link. */
export interface AuditDesign { artifactId: string; revision?: number }

export interface SubjectCriteria {
  taskId: string;
  taskTitle: string;
  specTitle: string;
  revision: number;
  /** The pinned revision's design (§12), when it has one. */
  design?: { kind: string; ref: string; version: string; screens: Array<{ id: string; name: string }> } | null;
  /** `captures`: the `scenario@viewport` captures a registered `verify:` check on it needs. */
  criteria: Array<{ id: string; text: string; screens?: string[]; captures?: string[] }>;
}

const screensFor = (body: string) => new Map(criterionScreens(body).map((x) => [x.criterionId, x.screens]));
const capturesFor = (body: string) => {
  try {
    return new Map([...criterionVerificationScenarios(body)].map(([id, list]) => [id, list.map((x) => `${x.scenarioId}@${x.viewport}`)]));
  } catch {
    return new Map<string, string[]>();
  }
};

const pinOf = (context: unknown): Record<string, unknown> | null => {
  const c = context && typeof context === 'object' ? (context as Record<string, unknown>).specSource : null;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
};

/**
 * The design for the audit: the mission's `design_reference`, else the design
 * a dependency's pinned spec revision names (when it is a buildd artifact).
 */
export function resolveAuditDesign(subjects: readonly SubjectCriteria[], missionDesign?: AuditDesign | null): (AuditDesign & { from: 'mission' | 'spec' }) | null {
  if (missionDesign) return { ...missionDesign, from: 'mission' };
  const pinned = subjects.find((s) => s.design?.kind === 'artifact')?.design;
  if (!pinned) return null;
  const revision = Number(pinned.version);
  return { artifactId: pinned.ref, ...(Number.isInteger(revision) && revision > 0 ? { revision } : {}), from: 'spec' };
}

/**
 * Design vs built (scripts/qa/design-capture.ts): a QA_DESIGN plan with every
 * criterion that names a screen, so the auditor renders those screens beside
 * its page shots and judges both. A criterion with no screen is judged as before.
 * A component screen (R-17) is compared with its dev fixture, not a route.
 */
function designVsBuilt(
  subjects: readonly SubjectCriteria[],
  design: AuditDesign & { from: 'mission' | 'spec' },
  screenInfo: readonly DesignScreenInfo[],
): string[] {
  const criteria = subjects.flatMap((s) => s.criteria.filter((c) => c.screens?.length).map((c) => ({ id: c.id, text: c.text, screens: c.screens! })));
  if (criteria.length === 0) return [];
  const named = new Set(criteria.flatMap((c) => c.screens));
  const components = screenInfo.filter((i) => named.has(i.id) && i.kind === 'component');
  const screens = Object.fromEntries(components.map((i) => [i.id, { kind: 'component', ...(i.code ? { code: i.code } : {}) }]));
  const plan = JSON.stringify({
    design: { artifactId: design.artifactId, ...(design.revision ? { revision: design.revision } : {}), file: '<the downloaded file>' },
    criteria,
    ...(components.length ? { screens } : {}),
  });
  return [
    '',
    '### Design vs built',
    design.from === 'mission'
      ? `Design: the mission's design_reference, artifact ${design.artifactId}${design.revision ? ` at revision ${design.revision}` : ''}. It replaces the spec's pin below.`
      : `Design: the spec's pin, artifact ${design.artifactId}${design.revision ? ` at revision ${design.revision}` : ''}.`,
    `1. Capture each route in the design's theme (\`theme=light\` for a Day design) at the screen's size: \`viewport=mobile\` (390x844) for phone screens, \`viewport=1440x900\` for desktop ones. Night/Day parity is captured and judged separately.`,
    `2. Download the design (\`get_artifact { artifactId: "${design.artifactId}"${design.revision ? `, revision: ${design.revision}` : ''} }\`, its download URL) into its own folder, then over each downloaded qa-screenshots folder run \`QA_DESIGN='<plan>' QA_OUTPUT=<folder> QA_VIEWPORT=<the viewport you captured> bun scripts/qa/design-capture.ts\` with this plan (add \`"routes": { "<screen>": "<route>" }\` when a screen's route is not named like it, e.g. a fixture):`,
    '```json',
    plan,
    '```',
    '3. It writes designs/<screen>.png, side-by-side/<shot>--<screen>.png (design | built) and design-captures.json. `bun scripts/qa/judge.ts prepare` then lists each pair under designChecks with the ask: differences that matter to the criterion (layout, content order, words, states shown), not pixels.',
    '4. Upload the side-by-side image and the design shot, cite the screen id in `observed`, and pass the design shot as `designShotIds`.',
    ...(components.length ? [
      '',
      'Component screens are checked on /app/dev/fixtures, not on a route: each specifies one component, so compare it with that component on its dev fixture (`?state=<fixture>`; the fixture that renders the screen\'s code component). A fixture per component state is fine. Page screens keep the real route.',
      ...components.map((i) => `- ${i.id} (${i.name})${i.code ? `, code ${i.code}` : ''}: capture its fixture at \`viewport=${i.viewport}\`, the screen's own size.`),
      `Add the fixtures to the plan, one per state: \`"routes": { "${components[0]!.id}": ["/app/dev/fixtures?state=…"] }\`. For these, name the screen id and the fixture URL in \`observed\`, and in a code review's design check the fixture is the route, with the state it shows as its reason.`,
    ] : []),
  ];
}

/** The prompt block. Null when no dependency is pinned to a spec. */
export function renderVisualAuditSpecCriteria(
  subjects: readonly SubjectCriteria[],
  missionDesign?: AuditDesign | null,
  /** The design's own screens (kind, code, size), when buildd could read them. */
  screenInfo: readonly DesignScreenInfo[] = [],
): string | null {
  const withCriteria = subjects.filter((s) => s.criteria.length > 0);
  if (withCriteria.length === 0) return null;
  const design = resolveAuditDesign(withCriteria, missionDesign);
  return [
    '## Spec criteria to judge (computed at claim)',
    'These tasks are built to an approved Living Spec. For each criterion below that a page can show, record one verdict with what you captured:',
    '',
    `\`manage_specs\` action=verdict { taskId, checker: "visual", criterionId, verdict: pass | fail | inconclusive, capturedSha: <the full commit your shots were taken at>, screenshotIds: [1-${MAX_VISUAL_SHOTS} of your own screenshot artifact ids], observed: <one line on what you saw> }`,
    '',
    '- Judge layout, content and states against the criterion text, not pixels. A pixel difference alone is not a fail; a state or step the criterion asks for that is missing or wrong is.',
    '- Skip a criterion nothing on screen can show. The code reviewer grades it, and your verdict would replace theirs.',
    '- inconclusive needs `observed` saying what you could not see; pass and fail need at least one screenshot.',
    '- A verdict is refused while the task\'s PR is not in the commit you captured. Say so in your summary rather than retrying.',
    ...(withCriteria.some((s) => s.design) ? [
      '- Where a criterion names design screens, open the design at the pinned version, render each named screen at the same viewport and state as your shot, screenshot it, upload it like any shot, and pass it as `designShotIds` (1-2). Judge whether the build matches the design in layout, content and states, not pixels. A verdict on such a criterion is refused without one.',
    ] : []),
    ...(withCriteria.some((s) => s.criteria.some((c) => c.captures?.length)) ? [
      '',
      '### Captures registered checks need',
      'Criteria marked "captures" also run registered checks on surface evidence you collect; buildd runs them when your run ends. Each named capture is a scenario at a viewport, and a check passes only when every one is there. For each:',
      '- Capture with a QA_PLAN route or state carrying `surface: { id: <the card\'s data-verify-surface>, scenario: <scenario> }`, at that viewport, with `QA_CAPTURE_SHA` set to the full commit you captured and `QA_SURFACE_COLLECTOR=visual_auditor` (scripts/qa/surface-evidence.ts).',
      '- Pass the scenario\'s runtime facts in `QA_SURFACE_FACTS` (`{ factVersion, scenarios }`), read from buildd or GitHub (the PR\'s state, its replacement, its verification), never from what the page says. A scenario you have no facts for records none; do not guess them.',
      '- Upload each `surfaces/<shot>.json` unchanged as your own `data` artifact (`create_artifact` type "data", content: the file). To cite its screenshot, upload that first and set `capture.screenshotRef` to its id. Do not edit an uploaded capture; capture again.',
      '- A capture the page could not provide (`surface.missing` in captures.json) stays missing: say so in your summary.',
    ] : []),
    ...withCriteria.flatMap((s) => [
      '',
      `### ${s.taskTitle}`,
      `taskId \`${s.taskId}\`, spec "${s.specTitle}" revision ${s.revision}`,
      ...(s.design ? [designLine(s.design)] : []),
      ...s.criteria.map((c) => `- **${c.id}** ${c.text}${c.screens?.length ? ` (screens: ${c.screens.join(', ')})` : ''}${c.captures?.length ? ` (captures: ${c.captures.join(', ')})` : ''}`),
    ]),
    ...(design ? designVsBuilt(withCriteria, design, screenInfo) : []),
  ].join('\n');
}

function designLine(d: NonNullable<SubjectCriteria['design']>): string {
  const open = d.kind === 'artifact'
    ? `get_artifact { artifactId: "${d.ref}", revision: ${d.version} }`
    : d.ref;
  return `Design: ${d.kind} at version ${d.version}, open with ${open}${d.screens.length ? `; screens ${d.screens.map((x) => `${x.id} (${x.name})`).join(', ')}` : ''}`;
}

export async function loadVisualAuditSpecCriteria(dependsOn: readonly string[]): Promise<SubjectCriteria[]> {
  if (dependsOn.length === 0) return [];
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(inArray(tasks.id, [...dependsOn])),
    columns: { id: true, title: true, context: true },
  });
  const out: SubjectCriteria[] = [];
  for (const row of rows) {
    const pin = pinOf(row.context);
    if (!pin || typeof pin.specId !== 'string') continue;
    const read = await readPinnedSpecRevision(pin);
    if (!read.ok) continue;
    const captures = capturesFor(read.body);
    out.push({
      taskId: row.id,
      taskTitle: row.title,
      specTitle: read.title,
      revision: read.revision,
      design: read.design ? { kind: read.design.kind, ref: read.design.ref, version: read.design.version, screens: read.design.screens ?? [] } : null,
      criteria: inScope(pin, specCriteria(read.body)).map((c) => {
        const screens = read.design ? screensFor(read.body).get(c.id) : undefined;
        const needed = captures.get(c.id);
        return { id: c.id, text: c.text, ...(screens?.length ? { screens } : {}), ...(needed?.length ? { captures: needed } : {}) };
      }),
    });
  }
  return out;
}

/** The mission's `design_reference` link, at its pinned revision, else the artifact's current one. */
export async function loadMissionDesign(missionId: string): Promise<AuditDesign | null> {
  const { artifactsLinkedTo } = await import('@/lib/artifact-links');
  const linked = await artifactsLinkedTo('mission', missionId, { relations: ['design_reference'] });
  const l = Array.isArray(linked) ? linked[0] : null;
  return l ? { artifactId: l.artifactId, revision: l.pinnedRevision ?? l.currentRevision } : null;
}

export async function attachVisualAuditSpecCriteria(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly AuditTask[],
  load: (dependsOn: readonly string[]) => Promise<SubjectCriteria[]> = loadVisualAuditSpecCriteria,
  missionDesign: (missionId: string) => Promise<AuditDesign | null> = loadMissionDesign,
  designScreens: (design: AuditDesign) => Promise<DesignScreenInfo[]> = loadDesignScreenInfo,
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find((t) => t.id === cw.taskId);
    if (!task || task.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG) continue;
    try {
      const deps = Array.isArray(task.dependsOn) ? (task.dependsOn as string[]) : [];
      const subjects = await load(deps);
      // A failed link read leaves the spec's pin in charge, never the block out.
      const linked = task.missionId ? await missionDesign(task.missionId).catch(() => null) : null;
      const resolved = resolveAuditDesign(subjects.filter((s) => s.criteria.length > 0), linked);
      // Unreadable kinds leave every screen a page: the plan still runs, and the file's data-kind still counts.
      const screenInfo = resolved ? await designScreens(resolved).catch(() => []) : [];
      const block = renderVisualAuditSpecCriteria(subjects, linked, screenInfo);
      if (!block) continue;
      const taskObj = cw.task as any;
      if (taskObj) {
        taskObj.context = taskObj.context ?? {};
        const withCriteria = subjects.filter((s) => s.criteria.length > 0);
        taskObj.context[VISUAL_AUDIT_SPEC_CRITERIA_CONTEXT_KEY] = withCriteria
          .map((s) => ({ taskId: s.taskId, revision: s.revision, criteria: s.criteria.map((c) => c.id) }));
        const design = resolveAuditDesign(withCriteria, linked);
        if (design) taskObj.context[VISUAL_AUDIT_DESIGN_CONTEXT_KEY] = design;
      }
      appendContextBlock(cw, block);
    } catch (err) {
      console.warn('[claim] visual audit spec criteria injection failed:', err);
    }
  }
}
