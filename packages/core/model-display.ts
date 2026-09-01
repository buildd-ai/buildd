/**
 * The one place a model id becomes something a person reads, and the one place
 * two model values are compared.
 *
 * Before this module there were four independent humanisers, and one was wrong:
 * a role page mapped the alias `opus` to the literal "Claude Opus 4", so it
 * mislabelled the premium model by two generations. An alias names a FAMILY, not
 * a release, so any version appended to it is a guess that goes stale silently.
 *
 * No DB dependency — safe to import from the runner, a server component, or a
 * client component, the same rule `model-tier-defaults.ts` follows.
 */

/** Families we can name; anything else passes through untouched. */
const FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'mythos']);

/** Non-Anthropic backends that report a bare word instead of a model id. */
const BACKEND_LABELS: Record<string, string> = { codex: 'Codex' };

interface ParsedModel {
  family: string;
  /** null for a bare alias like `sonnet` — a family with no release. */
  version: string | null;
}

/**
 * `claude-sonnet-4-6` -> sonnet 4.6, `claude-haiku-4-5-20251001` -> haiku 4.5
 * (a dated snapshot is the same release), `sonnet` -> sonnet with no version.
 */
export function parseModelId(id: string): ParsedModel | null {
  const raw = (id ?? '').trim().toLowerCase();
  if (!raw) return null;

  if (FAMILIES.has(raw)) return { family: raw, version: null };

  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(raw);
  if (!m || !FAMILIES.has(m[1])) return null;
  return { family: m[1], version: m[3] ? `${m[2]}.${m[3]}` : m[2] };
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A short human label: `claude-sonnet-5` -> "Sonnet 5", `sonnet` -> "Sonnet".
 * Returns the input unchanged when it names nothing we recognise, because a
 * mangled id is worse than a raw one for anyone debugging.
 */
export function getModelDisplayName(id: string | null | undefined): string {
  const raw = (id ?? '').trim();
  if (!raw) return '';

  const backend = BACKEND_LABELS[raw.toLowerCase()];
  if (backend) return backend;

  const parsed = parseModelId(raw);
  if (!parsed) return raw;
  return parsed.version ? `${titleCase(parsed.family)} ${parsed.version}` : titleCase(parsed.family);
}

type UsageLike = { inputTokens?: number; outputTokens?: number } | null | undefined;

export interface PrimaryModel {
  /** Highest-token model, or null when nothing was attributed. */
  primary: string | null;
  /** Every model reported, highest tokens first. */
  all: string[];
  /** True when more than one model ran — a fallback firing is a real feature. */
  multiple: boolean;
}

/**
 * Reduce `usage.byModel` to the model that did most of the work.
 *
 * Empty is a real and common answer: on seat/OAuth auth the SDK reports no
 * per-model usage at all, so callers must render an absence rather than a zero.
 */
export function primaryModelFromUsage(
  usage: Record<string, UsageLike> | null | undefined,
): PrimaryModel {
  const entries = Object.entries(usage ?? {});
  if (entries.length === 0) return { primary: null, all: [], multiple: false };

  const ranked = entries
    .map(([id, u]) => ({ id, tokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) }))
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));

  return {
    primary: ranked[0].id,
    all: ranked.map((r) => r.id),
    multiple: ranked.length > 1,
  };
}

export type DivergenceVerdict = 'agree' | 'diverged' | 'unattributed';

export interface Divergence {
  verdict: DivergenceVerdict;
  assigned: string | null;
  actual: string | null;
}

/**
 * Compare the model a task was assigned against the model that ran.
 *
 * Three rules, each earned by a real shape in the data:
 *  - `unattributed` when either side is missing, or when the actual value names
 *    no model (Codex reports the literal `codex`). Never fold this into
 *    `agree` — that is how a divergence rate reads 0% and means "never recorded".
 *  - an ALIAS agrees with any release in its family: `predicted_model` is a bare
 *    alias when a task has no team, and comparing it as a string would flag
 *    every such task.
 *  - two different releases of one family DIVERGE. Same-family is not enough:
 *    running 4.6 where 5 was assigned is the drift that costs real money.
 */
export function compareAssignedActual(
  assigned: string | null | undefined,
  actual: string | null | undefined,
): Divergence {
  const a = (assigned ?? '').trim();
  const b = (actual ?? '').trim();
  const out = { assigned: a || null, actual: b || null };

  if (!a || !b) return { verdict: 'unattributed', ...out };

  const pa = parseModelId(a);
  const pb = parseModelId(b);
  // An unrecognisable side names no model to compare — do not call it divergence.
  if (!pa || !pb) return { verdict: 'unattributed', ...out };

  if (pa.family !== pb.family) return { verdict: 'diverged', ...out };

  // One side is a family with no release: the family match is all we can check.
  if (pa.version === null || pb.version === null) return { verdict: 'agree', ...out };

  return { verdict: pa.version === pb.version ? 'agree' : 'diverged', ...out };
}
