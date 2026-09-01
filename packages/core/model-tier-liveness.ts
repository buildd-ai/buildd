/**
 * Audit the configured model tiers against the live Anthropic model list.
 *
 * Why this exists: which model is our "standard" tier is a POLICY decision
 * (a price/capability tradeoff), so `GET /v1/models` cannot supply it — that is
 * why TIER_DEFAULTS and `model_tier_registry` are hand-maintained. But the API
 * can prove the decision is still VALID, and nothing was doing that:
 * `standard` sat on `claude-sonnet-4-6` after `claude-sonnet-5` shipped at a
 * LOWER price ($2/$10 against $3/$15), so the fleet paid more for an older
 * model until a human happened to notice.
 *
 * Pure and synchronous on purpose: the caller supplies the live list (the app
 * already fetches it in `GET /api/models`), so this is testable with no network
 * and no API key. CI has no ANTHROPIC_API_KEY — only the deployed app does —
 * which is why the audit runs there rather than as a build gate.
 */

/** The `/v1/models` fields this audit uses. */
export interface LiveModel {
  id: string;
  display_name?: string;
}

interface AuditableTier {
  provider: string;
  model: string;
}

export interface TierAudit {
  /** False when the live list was empty — nothing was verified either way. */
  checked: boolean;
  /** Configured IDs the API does not return: retired, renamed, or a typo. */
  unknown: Array<{ tier: string; model: string }>;
  /** Configured IDs with a newer model available in the same family. */
  superseded: Array<{ tier: string; model: string; newer: string }>;
}

interface ParsedModel {
  family: string;
  major: number;
  minor: number;
}

/**
 * `claude-sonnet-5` -> sonnet 5.0, `claude-sonnet-4-6` -> sonnet 4.6,
 * `claude-haiku-4-5-20251001` -> haiku 4.5 (the date suffix is a snapshot of
 * the same version, not a newer one).
 */
export function parseAnthropicModelId(id: string): ParsedModel | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/.exec(id);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function isNewer(a: ParsedModel, b: ParsedModel): boolean {
  if (a.major !== b.major) return a.major > b.major;
  return a.minor > b.minor;
}

export function auditTierModels(
  tiers: Record<string, AuditableTier>,
  live: readonly LiveModel[],
): TierAudit {
  // An empty list means the fetch failed or the key is missing. Reporting every
  // model as retired would be a false alarm off an empty set — the same class of
  // mistake as a gate that passes because it measured nothing.
  if (live.length === 0) return { checked: false, unknown: [], superseded: [] };

  const liveIds = new Set(live.map((m) => m.id));
  const parsedLive = live
    .map((m) => ({ id: m.id, parsed: parseAnthropicModelId(m.id) }))
    .filter((m): m is { id: string; parsed: ParsedModel } => m.parsed !== null);

  const unknown: TierAudit['unknown'] = [];
  const superseded: TierAudit['superseded'] = [];

  for (const [tier, entry] of Object.entries(tiers)) {
    // /v1/models is Anthropic's catalog; it cannot speak for Codex or OpenRouter.
    if (entry.provider !== 'anthropic') continue;

    if (!liveIds.has(entry.model)) {
      unknown.push({ tier, model: entry.model });
      continue;
    }

    const mine = parseAnthropicModelId(entry.model);
    if (!mine) continue;

    const newer = parsedLive
      .filter((m) => m.parsed.family === mine.family && isNewer(m.parsed, mine))
      .sort((a, b) => (isNewer(a.parsed, b.parsed) ? -1 : 1))[0];
    if (newer) superseded.push({ tier, model: entry.model, newer: newer.id });
  }

  return { checked: true, unknown, superseded };
}
