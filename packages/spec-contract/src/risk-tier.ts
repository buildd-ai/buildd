import { criterionBlocks, type CriterionBlock } from './no-criteria-change';

/**
 * Risk tiers on waiting spec revisions (Living Spec b7fc9316 R-32, R-33).
 * Mechanical and offline: no model, nothing an agent sends. A tier orders and
 * groups the approval inbox; it never approves anything, and it never lets an
 * approval skip a person's click.
 *
 * - High: a person flagged the spec `risk: high` in its metadata, or the words
 *   of a changed criterion contain a RISK_KEYWORDS entry.
 * - Low: the spec is a domain charter, or has no criteria, or the change is
 *   display-only (no criterion changed, or each changed one differs only in its
 *   `screen:` lines or in spacing, case and punctuation).
 * - Medium: everything else. High wins over Low.
 */
export const RISK_TIERS = ['high', 'medium', 'low'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Whole words, any case. `auth` also matches `authz` and `authn`; nouns take a plural s. */
export const RISK_KEYWORDS = ['credential', 'secret', 'token', 'auth', 'authz', 'authn', 'login', 'approve', 'merge', 'permission', 'visible to'] as const;

const KEYWORD = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${RISK_KEYWORDS.map((k) => k.replace(/ /g, '\\s+')).join('|')})s?(?![\\p{L}\\p{N}_])`, 'giu');

export interface RiskInput {
  scope: string;
  /** The spec's metadata `risk` is `high`, set by a person. */
  flaggedHigh: boolean;
  /** The approved revision's body; null when nothing is approved (measured from nothing). */
  from: string | null;
  /** The head revision's body. */
  to: string;
}

export interface RiskResult {
  tier: RiskTier;
  /** Why, in plain words: each is one line a person can read beside the tier. */
  reasons: string[];
}

const LABEL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:check|screens?|verify|replaces)(?:\*\*|__)?\s*:/i;
const SCREEN = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?screens?(?:\*\*|__)?\s*:/i;

/** A criterion's words: its lines without check:/screen:/verify:/replaces: labels. */
const words = (b: CriterionBlock) => b.lines.filter((l) => !LABEL.test(l)).join('\n');
/** The same with spacing, case and punctuation gone: what "copy" can change. */
const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function changedBlocks(from: string | null, to: string): { changed: Array<{ id: string; before: CriterionBlock | null; after: CriterionBlock | null }>; hasCriteria: boolean } {
  const a = new Map(criterionBlocks(from ?? '').blocks.map((b) => [b.id, b]));
  const b = new Map(criterionBlocks(to).blocks.map((x) => [x.id, x]));
  const changed: Array<{ id: string; before: CriterionBlock | null; after: CriterionBlock | null }> = [];
  for (const [id, after] of b) {
    const before = a.get(id) ?? null;
    if (!before || before.lines.join('\n') !== after.lines.join('\n') || before.section !== after.section) changed.push({ id, before, after });
  }
  for (const [id, before] of a) if (!b.has(id)) changed.push({ id, before, after: null });
  return { changed, hasCriteria: b.size > 0 };
}

export function classifyRisk(input: RiskInput): RiskResult {
  const { changed, hasCriteria } = changedBlocks(input.from, input.to);

  const reasons: string[] = [];
  if (input.flaggedHigh) reasons.push('A person flagged this spec risk: high.');
  for (const c of changed) {
    const text = [c.before && words(c.before), c.after && words(c.after)].filter(Boolean).join('\n');
    const hits = [...new Set([...text.matchAll(KEYWORD)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' ')))];
    if (hits.length) reasons.push(`${c.id} changed and mentions ${hits.map((h) => `"${h}"`).join(', ')}.`);
  }
  if (reasons.length) return { tier: 'high', reasons };

  if (input.scope === 'domain') return { tier: 'low', reasons: ['A domain charter.'] };
  if (!hasCriteria) return { tier: 'low', reasons: ['The spec has no criteria.'] };
  if (changed.length === 0) return { tier: 'low', reasons: ['No criterion changed.'] };

  const displayOnly = changed.every((c) => c.before && c.after && c.before.section === c.after.section
    && flat(words(c.before)) === flat(words(c.after))
    // Only screen: lines or spacing/case/punctuation differ; a changed check: or replaces: line is a change of meaning.
    && c.before.lines.filter((l) => LABEL.test(l) && !SCREEN.test(l)).join('\n') === c.after.lines.filter((l) => LABEL.test(l) && !SCREEN.test(l)).join('\n'));
  if (displayOnly) return { tier: 'low', reasons: ['Display only: screen bindings or copy.'] };

  return { tier: 'medium', reasons: [`${changed.map((c) => c.id).join(', ')} changed.`] };
}

const RANK: Record<RiskTier, number> = { high: 0, medium: 1, low: 2 };

/** High first, then Medium, then Low; rows keep their given order within a tier. */
export function sortHighFirst<T extends { tier: RiskTier }>(rows: readonly T[]): T[] {
  return rows.map((r, i) => [r, i] as const).sort((x, y) => RANK[x[0].tier] - RANK[y[0].tier] || x[1] - y[1]).map(([r]) => r);
}

export const RISK_FILTERS = ['all', ...RISK_TIERS] as const;
export type RiskFilter = (typeof RISK_FILTERS)[number];

export const parseRiskFilter = (raw: unknown): RiskFilter => (typeof raw === 'string' && (RISK_FILTERS as readonly string[]).includes(raw) ? (raw as RiskFilter) : 'all');

/** The rows in one tier, or all of them. */
export function filterByTier<T extends { tier: RiskTier }>(rows: readonly T[], filter: RiskFilter): T[] {
  return filter === 'all' ? [...rows] : rows.filter((r) => r.tier === filter);
}
