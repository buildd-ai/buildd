/**
 * The mission page's Visual review (docs/design/visual-qa-auditor.md, "Where
 * the screenshots show"). Pure; safe on the client.
 *
 * The auditor uploads one `screenshot` artifact per route × viewport, each
 * with `metadata.qa = { runKey, route, viewport, finding, verdict }`. A run is
 * the set of shots sharing a `runKey`. Metadata is free-form JSON written by an
 * agent, so every field is validated here and a malformed shot is dropped
 * rather than rendered half-empty.
 */
import type { DeliveryVisual } from './mission-delivery';

export const QA_VERDICTS = ['ok', 'issue', 'unsure'] as const;
export type QaVerdict = (typeof QA_VERDICTS)[number];

export interface QaMeta {
  runKey: string;
  /** The route pattern (`/app/tasks/:id`), not a concrete URL. */
  route: string;
  viewport: string;
  finding: string;
  verdict: QaVerdict;
  theme?: string;
  fixTaskId?: string;
}

export interface VisualShot {
  id: string;
  createdAt: string;
  /** Image URL. The download route for real rows; fixtures pass their own. */
  src: string;
  qa: QaMeta;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** `metadata.qa` when every required field is present and well-typed, else null. */
export function parseQaMeta(metadata: unknown): QaMeta | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const qa = (metadata as Record<string, unknown>).qa;
  if (typeof qa !== 'object' || qa === null || Array.isArray(qa)) return null;
  const q = qa as Record<string, unknown>;
  if (!nonEmpty(q.runKey) || !nonEmpty(q.route) || !nonEmpty(q.viewport) || !nonEmpty(q.finding)) return null;
  if (!(QA_VERDICTS as readonly unknown[]).includes(q.verdict)) return null;
  const meta: QaMeta = {
    runKey: q.runKey,
    route: q.route,
    viewport: q.viewport,
    finding: q.finding,
    verdict: q.verdict as QaVerdict,
  };
  if (nonEmpty(q.theme)) meta.theme = q.theme;
  if (nonEmpty(q.fixTaskId)) meta.fixTaskId = q.fixTaskId;
  return meta;
}

/**
 * The thumbnail URL: the existing access-checked download route, which
 * redirects to a signed GET. Never a share token: audit shots are private.
 */
export function thumbSrc(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/download`;
}

interface ArtifactRowLike {
  id: string;
  type: string;
  createdAt: string | Date;
  metadata: unknown;
}

/** Audit screenshots with a valid `metadata.qa`, oldest first. */
export function toVisualShots(rows: readonly ArtifactRowLike[]): VisualShot[] {
  const shots: VisualShot[] = [];
  for (const row of rows) {
    if (row.type !== 'screenshot') continue;
    const qa = parseQaMeta(row.metadata);
    if (!qa) continue;
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString();
    shots.push({ id: row.id, createdAt, src: thumbSrc(row.id), qa });
  }
  return shots.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The shots of the most recent run: the `runKey` whose newest shot is newest. */
export function selectLatestRun(shots: readonly VisualShot[]): VisualShot[] {
  const newest = new Map<string, number>();
  for (const s of shots) {
    const t = Date.parse(s.createdAt);
    newest.set(s.qa.runKey, Math.max(newest.get(s.qa.runKey) ?? -Infinity, t));
  }
  let latest: string | null = null;
  let latestAt = -Infinity;
  for (const [key, at] of newest) {
    if (at > latestAt) {
      latest = key;
      latestAt = at;
    }
  }
  return latest == null ? [] : shots.filter(s => s.qa.runKey === latest);
}

/** Verdict counts for the Delivery step (`buildDeliverySteps` → `visual`). */
export function summarizeVisualRun(
  shots: readonly VisualShot[],
  opts: { required?: number; bootFailed?: boolean } = {},
): DeliveryVisual {
  const count = (v: QaVerdict) => shots.filter(s => s.qa.verdict === v).length;
  return {
    shots: shots.length,
    ok: count('ok'),
    issues: count('issue'),
    unsure: count('unsure'),
    ...(opts.required != null ? { required: opts.required } : {}),
    ...(opts.bootFailed ? { bootFailed: true } : {}),
  };
}
