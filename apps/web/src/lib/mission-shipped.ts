/**
 * The mission "What shipped" record, pure half (docs/design/mission-shipped-report.md).
 *
 * The author task writes a lede, an off-plan note and a NOMINATION of hero
 * shots. Everything here is what the server decides about that output: what
 * kind of change it was, which screenshots exist, whether the lede is fit to
 * show. No db, no network: `mission-shipped-report.ts` loads the inputs and
 * stores the result. Safe on the client.
 */
import { isGeneratedPath } from '@buildd/shared';
import {
  SHIPPED_HERO_SHOTS_MAX,
  SHIPPED_LEDE_MAX_CHARS,
  SHIPPED_OFF_PLAN_LINE_MAX_CHARS,
  SHIPPED_OFF_PLAN_MAX_LINES,
} from '@buildd/shared';
import { isUiSurfacePath } from '@buildd/core/surface-audit';
import { isAdvisoryManifest } from '@buildd/core/path-overlap';
import { selectLatestRun, type QaVerdict, type QaViewport, type VisualShot } from './mission-visual-review';

export type ShippedChangeType = 'frontend' | 'backend' | 'both' | null;
export type ShippedOrigin = 'author' | 'no_author' | 'manual';

export interface ShippedHeroShot {
  artifactId: string;
  route: string;
  viewport: QaViewport;
  verdict: QaVerdict;
}

export interface ShippedRecord {
  version: 1;
  lede: string | null;
  changeType: ShippedChangeType;
  heroShots: ShippedHeroShot[];
  offPlan: string[];
  authorTaskId: string | null;
  origin: ShippedOrigin;
  /** `missions.completedAt` when written: a reopened mission no longer matches it. */
  completedAt: string;
}

// ── Change type ─────────────────────────────────────────────────────────────

const DOC_EXTENSION = /\.(md|mdx|txt)$/i;

/** Docs and tooling output say nothing about whether a change is frontend or backend. */
function isCodePath(path: string): boolean {
  const p = path.replace(/^\/+/, '');
  if (p.startsWith('docs/')) return false;
  if (DOC_EXTENSION.test(p)) return false;
  return !isGeneratedPath(p);
}

/**
 * `frontend` if any changed code path is a UI surface, `backend` if the changed
 * code is all non-UI, `both` when it is a mix, `null` for docs-only or no code.
 */
export function classifyChangedPaths(paths: readonly string[]): ShippedChangeType {
  let ui = false;
  let nonUi = false;
  for (const path of paths) {
    if (!isCodePath(path)) continue;
    if (isUiSurfacePath(path)) ui = true;
    else nonUi = true;
  }
  if (ui && nonUi) return 'both';
  if (ui) return 'frontend';
  if (nonUi) return 'backend';
  return null;
}

/**
 * The fallback when PR files cannot be read: what the deliverable tasks
 * declared. A manifest carrying the `['**']` "scope undeclared" sentinel says
 * nothing and is ignored whole.
 */
export function changeTypeFromManifests(manifests: ReadonlyArray<readonly string[] | null | undefined>): ShippedChangeType {
  const declared = manifests.flatMap(m => (m && !isAdvisoryManifest([...m]) ? [...m] : []));
  return classifyChangedPaths(declared);
}

// ── Lede check ──────────────────────────────────────────────────────────────

// Each entry is something the lede prompt forbids and that can be seen without
// judging prose. A mechanical filter, not a judge: a lede that trips one is
// not shown, it is not retried.
const LEDE_FORBIDDEN: ReadonlyArray<{ reason: string; test: RegExp }> = [
  { reason: 'backticked token', test: /`/ },
  { reason: 'PR or issue number', test: /(^|[^\w&])#\d+/ },
  { reason: 'UUID', test: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  // Hex run with a digit AND a letter, so "defaced", "effaced" and "1000000" are not SHAs.
  { reason: 'commit hash', test: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i },
  // Two or more slashes (apps/web/src), a leading slash (/api/x, ./x, ~/x), or a file name.
  // "and/or" and "24/7" have neither.
  { reason: 'file path', test: /\b[\w.-]+(\/[\w.-]+){2,}/ },
  { reason: 'file path', test: /(^|[\s(])(\.{1,2}\/|~\/|\/)[\w.[-]/ },
  { reason: 'file path', test: /\b[\w-]+\.(tsx?|jsx|mjs|json|md|sql|css|ya?ml|sh|py|toml)\b/i },
  // fooBarBaz, FooBarBaz, foo_bar, foo(): at least two humps, so "iPhone" and "GitHub" pass.
  { reason: 'symbol name', test: /\b[a-z]+(?:[A-Z][a-z0-9]+){2,}\b/ },
  { reason: 'symbol name', test: /\b(?:[A-Z][a-z0-9]+){3,}\b/ },
  { reason: 'symbol name', test: /\b[a-z0-9]+_[a-z0-9_]+\b/ },
  { reason: 'symbol name', test: /\b\w+\(\)/ },
];

export type LedeCheck = { ok: true; lede: string } | { ok: false; reason: string };

export function checkLede(raw: unknown): LedeCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'missing' };
  const lede = raw.replace(/\s+/g, ' ').trim();
  if (!lede) return { ok: false, reason: 'empty' };
  if (lede.length > SHIPPED_LEDE_MAX_CHARS) {
    return { ok: false, reason: `over ${SHIPPED_LEDE_MAX_CHARS} characters` };
  }
  for (const { reason, test } of LEDE_FORBIDDEN) {
    if (test.test(lede)) return { ok: false, reason };
  }
  return { ok: true, lede };
}

// ── Off plan ────────────────────────────────────────────────────────────────

/** At most 2 lines of at most 160 characters; blanks and non-strings are dropped. */
export function trimOffPlan(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const line = item.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    lines.push(
      line.length > SHIPPED_OFF_PLAN_LINE_MAX_CHARS
        ? `${line.slice(0, SHIPPED_OFF_PLAN_LINE_MAX_CHARS - 1).trimEnd()}…`
        : line,
    );
    if (lines.length === SHIPPED_OFF_PLAN_MAX_LINES) break;
  }
  return lines;
}

// ── Hero shots ──────────────────────────────────────────────────────────────

/** The latest audit run's screenshots the auditor did not flag as an issue. */
export function buildHeroPool(shots: readonly VisualShot[]): ShippedHeroShot[] {
  return selectLatestRun(shots)
    .filter(s => s.qa.verdict !== 'issue')
    .map(s => ({ artifactId: s.id, route: s.qa.route, viewport: s.qa.viewport, verdict: s.qa.verdict }));
}

/** Mobile before desktop, then route and id so the same pool always picks the same shots. */
function deterministicOrder(pool: readonly ShippedHeroShot[]): ShippedHeroShot[] {
  const rank = (v: QaViewport) => (v === 'mobile' ? 0 : 1);
  return [...pool].sort(
    (a, b) =>
      rank(a.viewport) - rank(b.viewport) ||
      a.route.localeCompare(b.route) ||
      a.artifactId.localeCompare(b.artifactId),
  );
}

/**
 * The model can only select: nominated ids are kept only when they are in the
 * pool (in the order nominated, without repeats). If none survive, the server
 * picks. At most 3 either way.
 */
export function pickHeroShots(nominated: unknown, pool: readonly ShippedHeroShot[]): ShippedHeroShot[] {
  const byId = new Map(pool.map(s => [s.artifactId, s]));
  const kept: ShippedHeroShot[] = [];
  if (Array.isArray(nominated)) {
    for (const id of nominated) {
      const shot = typeof id === 'string' ? byId.get(id) : undefined;
      if (shot && !kept.includes(shot)) kept.push(shot);
      if (kept.length === SHIPPED_HERO_SHOTS_MAX) break;
    }
  }
  if (kept.length > 0) return kept;
  return deterministicOrder(pool).slice(0, SHIPPED_HERO_SHOTS_MAX);
}

// ── The record ──────────────────────────────────────────────────────────────

export interface BuildShippedRecordInput {
  /**
   * The author's `shipped` output, or null when there is no usable author: a
   * completion with none, a session that ended on fallback text, a human.
   */
  authorShipped: unknown;
  authorTaskId: string | null;
  manual: boolean;
  changeType: ShippedChangeType;
  pool: readonly ShippedHeroShot[];
  /** `dataClass === 'sensitive'`: no prose is stored, only facts. */
  sensitive: boolean;
  completedAt: Date | string;
}

export function buildShippedRecord(input: BuildShippedRecordInput): { record: ShippedRecord; ledeRejection: string | null } {
  const shipped = input.authorShipped && typeof input.authorShipped === 'object' && !Array.isArray(input.authorShipped)
    ? (input.authorShipped as Record<string, unknown>)
    : null;

  // A lede that fails the check makes the author "missing": its nominations
  // and its off-plan note are not trusted either.
  let ledeRejection: string | null = null;
  let lede: string | null = null;
  if (!input.manual && shipped) {
    const checked = checkLede(shipped.lede);
    if (checked.ok) lede = checked.lede;
    else ledeRejection = checked.reason;
  }
  const authored = lede !== null;

  const origin: ShippedOrigin = input.manual ? 'manual' : authored ? 'author' : 'no_author';
  const completedAt = typeof input.completedAt === 'string' ? input.completedAt : input.completedAt.toISOString();

  return {
    ledeRejection,
    record: {
      version: 1,
      lede: input.sensitive ? null : lede,
      changeType: input.changeType,
      heroShots: pickHeroShots(authored ? shipped?.heroShots : undefined, input.pool),
      offPlan: authored && !input.sensitive ? trimOffPlan(shipped?.offPlan) : [],
      authorTaskId: input.manual ? null : input.authorTaskId,
      origin,
      completedAt,
    },
  };
}

/**
 * Reopening a mission changes `completedAt`; the old record then describes a
 * completion that was undone, and surfaces ignore it until the next one.
 */
export function isShippedRecordCurrent(
  record: Pick<ShippedRecord, 'completedAt'>,
  missionCompletedAt: Date | string | null | undefined,
): boolean {
  if (!missionCompletedAt) return false;
  const at = new Date(missionCompletedAt).getTime();
  return !Number.isNaN(at) && new Date(record.completedAt).getTime() === at;
}

/** The record stored in `metadata.shipped`, or null when it is not a version-1 record. */
export function parseShippedRecord(raw: unknown): ShippedRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.completedAt !== 'string') return null;
  return r as unknown as ShippedRecord;
}

/** A short markdown render for knowledge readers; the page reads the record itself. */
export function renderShippedMarkdown(record: ShippedRecord): string {
  const lines = ['## What shipped', ''];
  if (record.lede) lines.push(record.lede, '');
  if (record.changeType) lines.push(`Change type: ${record.changeType}`);
  if (record.origin === 'manual') lines.push('Completed by hand.');
  if (record.heroShots.length > 0) {
    lines.push('', 'Screenshots:');
    for (const s of record.heroShots) lines.push(`- ${s.route} (${s.viewport}, ${s.verdict})`);
  }
  if (record.offPlan.length > 0) {
    lines.push('', 'Off plan:');
    for (const line of record.offPlan) lines.push(`- ${line}`);
  }
  return lines.join('\n').trim();
}
