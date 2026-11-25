/**
 * What a person sees and decides about a connector's tool classes.
 *
 *  - Settings › Team › Apps lists a connector's tools with the class the
 *    gateway gives each (read / write / admin / denied) and where that class
 *    came from: the provider's annotation, the catalog's vetted reads, the
 *    admin's override, the tool's name, or the fail-closed default for a tool
 *    nothing describes. The tools come from the last `tools/list` the gateway
 *    saw (`discoveredMetadata.toolSnapshot`), the admin's lists, the catalog's
 *    vetted reads, and tools refused recently.
 *  - Home's Needs You carries one card per (connector, tool) refused only
 *    because buildd does not know it reads (the gateway's audit row marks it
 *    `readOnlyFix`). "Treat as read-only" saves `markReadOnly`; "Keep blocked"
 *    records the tool in `discoveredMetadata.toolReview.keptBlocked`, so the
 *    card does not come back. A tool already read-only, denied or kept blocked
 *    gets no card, so a decision clears it on the next read.
 *
 * Every write goes through PATCH /api/connectors/<id>, which needs a signed-in
 * session: an agent's key never widens its own read class.
 *
 * Spec: docs/specs/capability-requests.md → Connector gateway.
 */
import { classifyToolRisk } from './capability-grants';
import { providerName } from './capability-grants-view';
import { TOOL_NAME_RE, classifyNativeTool, readToolOverrides, type ToolAnnotations, type ToolClass, type ToolOverrides } from './connector-gateway';
import type { WaitingOnYouRawItem } from './action-queue';
import type { ConnectorToolRow, ToolClassSource } from './connector-tool-labels';

export { TOOL_SOURCE_LABEL, type ConnectorToolRow, type ToolClassSource } from './connector-tool-labels';

/** At most this many tools are kept from one `tools/list`. */
export const MAX_SNAPSHOT_TOOLS = 300;
/** At most this many tools are kept blocked on one connector. */
export const MAX_KEPT_BLOCKED = 200;

/** The provider facts that decide a class, compact: `r` readOnlyHint, `d` destructiveHint. */
export interface SnapshotTool { r?: boolean; d?: boolean }
export interface ToolSnapshot { at: string; tools: Record<string, SnapshotTool> }

/** Pure. A snapshot of the tools the provider listed, only the hints the gateway reads. Null for none. */
export function toolSnapshotOf(annotations: ReadonlyMap<string, ToolAnnotations | null>, at: Date): ToolSnapshot | null {
  const tools: Record<string, SnapshotTool> = {};
  let n = 0;
  for (const name of [...annotations.keys()].sort()) {
    if (!TOOL_NAME_RE.test(name)) continue;
    if (n++ >= MAX_SNAPSHOT_TOOLS) break;
    const a = annotations.get(name);
    const t: SnapshotTool = {};
    if (typeof a?.readOnlyHint === 'boolean') t.r = a.readOnlyHint;
    if (typeof a?.destructiveHint === 'boolean') t.d = a.destructiveHint;
    tools[name] = t;
  }
  return n ? { at: at.toISOString(), tools } : null;
}

/** A stable signature of a snapshot's tools (not its time), to skip writing an unchanged one. */
export const snapshotSignature = (s: ToolSnapshot) => JSON.stringify(s.tools);

export function readToolSnapshot(discoveredMetadata: unknown): ToolSnapshot | null {
  const s = (discoveredMetadata as { toolSnapshot?: unknown } | null | undefined)?.toolSnapshot as ToolSnapshot | undefined;
  if (!s || typeof s !== 'object' || !s.tools || typeof s.tools !== 'object') return null;
  return { at: typeof s.at === 'string' ? s.at : '', tools: s.tools };
}

const toAnnotations = (t: SnapshotTool | undefined): ToolAnnotations | null =>
  t ? { ...(t.r !== undefined ? { readOnlyHint: t.r } : {}), ...(t.d !== undefined ? { destructiveHint: t.d } : {}) } : null;

/** The tools a person chose to keep blocked from Home: no card for them again. */
export function readKeptBlocked(discoveredMetadata: unknown): Set<string> {
  const r = (discoveredMetadata as { toolReview?: { keptBlocked?: unknown } } | null | undefined)?.toolReview?.keptBlocked;
  return new Set(Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && TOOL_NAME_RE.test(x)) : []);
}

/** Pure. The kept-blocked list with one more tool. Null for a name that is not one exact tool name, or a full list. */
export function withKeptBlocked(discoveredMetadata: unknown, tool: unknown): { keptBlocked: string[] } | null {
  if (typeof tool !== 'string' || !TOOL_NAME_RE.test(tool)) return null;
  const keptBlocked = [...new Set([...readKeptBlocked(discoveredMetadata), tool])].sort();
  if (keptBlocked.length > MAX_KEPT_BLOCKED) return null;
  return { keptBlocked };
}

/**
 * Pure. The gateway's class for a listed tool (`classifyNativeTool` with no
 * call arguments) and where it came from, checked in the gateway's order.
 */
export function classifyWithSource(name: string, annotations: ToolAnnotations | null | undefined, overrides: ToolOverrides): { cls: ToolClass; source: ToolClassSource } {
  const cls = classifyNativeTool(name, annotations, overrides);
  const byName = classifyToolRisk(name);
  let source: ToolClassSource;
  if (overrides.denyTools.has(name)) source = 'admin';
  else if (annotations?.destructiveHint === true) source = 'provider';
  else if (overrides.readOnlyTools.has(name)) source = 'admin';
  else if (annotations?.readOnlyHint === true) source = byName === 'admin' ? 'name' : 'provider';
  else if (byName === 'admin') source = 'name';
  else if (overrides.vettedReadTools?.has(name) && annotations?.readOnlyHint !== false) source = 'catalog';
  else if (overrides.readOnlyUnless?.has(name)) source = 'catalog';
  else source = annotations?.readOnlyHint === false ? 'provider' : 'default';
  return { cls, source };
}

/**
 * Pure. Every tool buildd knows for this connector, with its class and
 * source, sorted by name. Unknown to the provider list, a tool's class is
 * what it would be with no annotations.
 */
export function connectorToolRows(discoveredMetadata: unknown, provider: string | null | undefined, refused: readonly string[] = []): ConnectorToolRow[] {
  const overrides = readToolOverrides(discoveredMetadata, provider);
  const snap = readToolSnapshot(discoveredMetadata);
  const refusedSet = new Set(refused);
  const names = new Set<string>([
    ...Object.keys(snap?.tools ?? {}),
    ...overrides.readOnlyTools, ...overrides.denyTools,
    ...(overrides.vettedReadTools ?? []),
    ...refusedSet,
  ]);
  return [...names].filter(n => TOOL_NAME_RE.test(n)).sort().map(name => {
    const { cls, source } = classifyWithSource(name, toAnnotations(snap?.tools[name]), overrides);
    return {
      name, cls, source,
      adminReadOnly: overrides.readOnlyTools.has(name),
      adminDenied: overrides.denyTools.has(name),
      listed: !!snap && name in snap.tools,
      refused: refusedSet.has(name),
    };
  });
}

// ── Needs You ────────────────────────────────────────────────────────────────

/** Where a person sees a connector's tools. */
export const connectorToolsHref = (connectorId: string, baseUrl = '') =>
  `${baseUrl}/app/settings/apps?tools=${encodeURIComponent(connectorId)}#team-apps`;

/** One recent refusal the read-only fix could have avoided, as Home reads it. */
export interface UnvettedRefusalRow {
  connectorId: string;
  connectorName: string | null;
  discoveredMetadata: unknown;
  provider: string | null;
  tool: string;
  taskId: string | null;
  taskTitle: string | null;
  roleSlug: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
}

/** Does this tool still need a person's decision? Not once it reads, is denied, or was kept blocked. */
export function toolStillUnreviewed(discoveredMetadata: unknown, provider: string | null, tool: string): boolean {
  if (readKeptBlocked(discoveredMetadata).has(tool)) return false;
  const overrides = readToolOverrides(discoveredMetadata, provider);
  if (overrides.denyTools.has(tool) || overrides.readOnlyTools.has(tool)) return false;
  return !overrides.vettedReadTools?.has(tool);
}

/**
 * Pure. One card per (connector, tool), newest refusal first: repeated
 * refusals of the same tool are one item, and a tool someone has decided on
 * gets none.
 */
export function unvettedToolNeedsYouItems(rows: readonly UnvettedRefusalRow[], baseUrl = ''): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.connectorId}/${r.tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!toolStillUnreviewed(r.discoveredMetadata, r.provider, r.tool)) continue;
    // A custom connector's audit provider is `connector:<name>`: its own name reads better.
    const app = r.provider && !r.provider.startsWith('connector:') ? providerName(r.provider) : (r.connectorName?.trim() || 'a connector');
    const who = r.taskTitle?.trim() || (r.roleSlug ? `A ${r.roleSlug} agent` : 'An agent');
    items.push({
      kind: 'access',
      accessToolFix: { connectorId: r.connectorId, tool: r.tool, appName: app },
      accessAsk: `${app} ${r.tool}`,
      taskId: r.taskId ?? undefined,
      taskTitle: r.taskTitle ?? undefined,
      workspaceId: r.workspaceId ?? undefined,
      workspaceName: r.workspaceName ?? null,
      failureMessage: `${who} was refused ${app} ${r.tool} because buildd doesn't know it's read-only`,
      fixHref: connectorToolsHref(r.connectorId, baseUrl),
      fixLabel: 'Tools',
    });
  }
  return items;
}

/** How far back a refusal still asks for a decision. */
export const UNVETTED_REFUSAL_WINDOW_MS = 7 * 86_400_000;

/**
 * Home's read for its batch: the gateway's refusals marked `readOnlyFix` in
 * these workspaces over the last week, on this team's connectors, the newest
 * per (connector, tool), at most 25. Only a viewer who can manage connectors
 * asks. Reads only.
 */
export async function unvettedToolNeedsYouRead(teamId: string, workspaceIds: readonly string[], now = Date.now()) {
  const [{ db }, { agentCapabilityDecisions, connectors, tasks, workspaces }, { and, desc, eq, gte, inArray, sql }, { TOOL_CALL_CAPABILITY }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./connector-gateway-store'),
  ]);
  const d = agentCapabilityDecisions;
  const query = db.selectDistinctOn([d.resource], {
    resource: d.resource,
    connectorId: connectors.id, connectorName: connectors.name, discoveredMetadata: connectors.discoveredMetadata,
    provider: sql<string | null>`${d.sideEffect}->>'provider'`,
    tool: sql<string>`${d.sideEffect}->>'tool'`,
    taskId: d.taskId, taskTitle: tasks.title, roleSlug: tasks.roleSlug,
    workspaceId: d.workspaceId, workspaceName: workspaces.name,
    occurredAt: d.occurredAt,
  })
    .from(d)
    .innerJoin(connectors, eq(sql`${connectors.id}::text`, sql`${d.sideEffect}->>'connectorId'`))
    .leftJoin(tasks, eq(tasks.id, d.taskId))
    .leftJoin(workspaces, eq(workspaces.id, d.workspaceId))
    .where(and(
      inArray(d.workspaceId, [...workspaceIds]),
      eq(d.capability, TOOL_CALL_CAPABILITY),
      eq(d.decision, 'refused'),
      gte(d.occurredAt, new Date(now - UNVETTED_REFUSAL_WINDOW_MS)),
      sql`(${d.sideEffect}->>'readOnlyFix')::boolean is true`,
      eq(connectors.teamId, teamId),
    ))
    .orderBy(d.resource, desc(d.occurredAt))
    .limit(25);
  type Row = Awaited<typeof query>[number];
  return {
    query,
    items: (rows: readonly Row[]): WaitingOnYouRawItem[] => unvettedToolNeedsYouItems(
      [...rows].filter(r => typeof r.tool === 'string' && r.tool.length > 0)
        .sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt)) as unknown as UnvettedRefusalRow[],
    ),
  };
}
