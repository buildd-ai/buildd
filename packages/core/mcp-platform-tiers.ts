/**
 * manage_platform_tiers: the platform default model per tier, for a platform
 * admin over MCP. A thin text renderer over /api/model-tiers/platform; the
 * route and the shared function behind it (apps/web/src/lib/admin/platform-tier-defaults.ts)
 * hold the admin check, the guard rails and the audit row, the same ones the
 * Settings section uses. Nothing here decides anything.
 */
import type { ActionContext, ApiFn } from './mcp-tools';

export type PlatformTiersOp = 'list' | 'set' | 'apply' | 'clear' | 'revert';

interface Facts {
  price: { input: number; output: number } | null;
  floor: string | null;
  certification: string;
  certified: boolean;
}

interface TierView {
  tier: string;
  band: { minInput: number; maxInput: number };
  effective: { provider: string; model: string; source: string; facts: Facts };
  platform: { model: string; setAt: string; setBy: { via: string; accountId: string | null; userId: string | null }; reason: string | null; previous: { model: string } | null } | null;
  suggestion: { kind: 'newer' | 'missing'; newer: string | null; applicable: boolean; needsBandConfirm: boolean; why: string } | null;
  canRevert: boolean;
}

interface View {
  tiers: TierView[];
  catalogChecked: boolean;
  canWrite: boolean;
}

interface ChangeResult {
  ok: true;
  op: PlatformTiersOp;
  tier: string;
  before: { model: string } | null;
  after: { model: string } | null;
  effective: { model: string; source: string };
  facts: Facts | null;
}

const money = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

export function priceLine(f: Facts): string {
  return f.price ? `${money(f.price.input)} in / ${money(f.price.output)} out per MTok` : 'price unknown';
}

export function floorLine(f: Facts): string {
  if (f.floor) return `Claude Code ${f.floor} or newer`;
  return f.certified ? 'any current runner' : `floor not certified (${f.certification})`;
}

const SOURCE_TEXT: Record<string, string> = {
  platform: 'platform default',
  policy: 'policy service',
  catalog: 'catalog pick (newest certified in band)',
  default: 'bundled fallback',
};

/** One tier of the list as text. Exported for the renderer test. */
export function describePlatformTier(t: TierView): string {
  const e = t.effective;
  const lines = [
    `  ${t.tier}: ${e.model} (source: ${SOURCE_TEXT[e.source] ?? e.source}, ${priceLine(e.facts)}, ${floorLine(e.facts)}; band ${money(t.band.minInput)} to ${money(t.band.maxInput)} input)`,
  ];
  if (t.platform) {
    const who = t.platform.setBy.userId ? `user ${t.platform.setBy.userId}` : t.platform.setBy.accountId ? `account ${t.platform.setBy.accountId}` : 'unknown';
    lines.push(
      `    set ${t.platform.setAt.slice(0, 16).replace('T', ' ')} UTC via ${t.platform.setBy.via} by ${who}` +
        (t.platform.reason ? `: ${t.platform.reason}` : '') +
        (t.platform.previous ? ` (revert restores ${t.platform.previous.model})` : ' (revert removes the row)'),
    );
  }
  if (t.suggestion) {
    lines.push(`    suggestion: ${t.suggestion.why}`);
    if (t.suggestion.kind === 'newer' && t.suggestion.applicable) {
      lines.push(`    apply it with action=apply tier=${t.tier} confirm=true${t.suggestion.needsBandConfirm ? ' confirmBandChange=true' : ''}`);
    }
  }
  return lines.join('\n');
}

/** The route's error body, out of the `API error: <status> - <json>` text the self-call throws. */
function routeError(err: unknown): { status: number | null; error: string; code: string | null } {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^API error: (\d{3}) - ([\s\S]*)$/.exec(msg);
  if (!m) return { status: null, error: msg, code: null };
  try {
    const body = JSON.parse(m[2]) as { error?: string; code?: string };
    return { status: Number(m[1]), error: body.error ?? m[2], code: body.code ?? null };
  } catch {
    return { status: Number(m[1]), error: m[2], code: null };
  }
}

export async function handlePlatformTiersAction(
  api: ApiFn,
  op: PlatformTiersOp,
  params: Record<string, any>,
  _ctx: ActionContext,
): Promise<string> {
  if (op === 'list') {
    const view = (await api('/api/model-tiers/platform')) as View;
    const header = `Platform tier defaults (what every team without its own row runs):\n\n`;
    const body = view.tiers.map(describePlatformTier).join('\n');
    const footer =
      (view.catalogChecked ? '' : '\n\nThe live catalog could not be read, so no staleness check ran this time.') +
      (view.canWrite
        ? `\n\nChange one with action=set tier=<tier> model=<id> confirm=true [confirmBandChange=true] [reason="…"]; action=apply takes a suggestion; action=clear removes the row; action=revert restores what the last change replaced. Every change is audited and takes effect on the next claim (within 60s). Team and workspace rows still win.`
        : `\n\nRead-only for this caller: only a platform admin changes these. A team pins its own tier with manage_model_tiers action=set.`);
    return header + body + footer;
  }

  const tier = typeof params.tier === 'string' ? params.tier : '';
  if (!tier) throw new Error(`tier is required for action=${op}`);
  const body: Record<string, unknown> = { op, tier, via: 'mcp' };
  if (op === 'set') {
    const model = typeof params.model === 'string' ? params.model.trim() : '';
    if (!model) throw new Error('model is required for action=set (a full Anthropic model id)');
    body.model = model;
  }
  if (params.confirm === true) body.confirm = true;
  if (params.confirmBandChange === true) body.confirmBandChange = true;
  if (typeof params.reason === 'string' && params.reason.trim()) body.reason = params.reason.trim();

  let r: ChangeResult;
  try {
    r = (await api('/api/model-tiers/platform', { method: 'PUT', body: JSON.stringify(body) })) as ChangeResult;
  } catch (err) {
    const e = routeError(err);
    if (e.status === null) throw err;
    const hint =
      e.code === 'confirm_required' ? ' Repeat the call with confirm=true.'
      : e.code === 'spend_band_change' ? ' Repeat the call with confirm=true confirmBandChange=true to accept the spend change.'
      : e.code === 'operator_only' ? ' This needs a platform admin: a signed-in operator session or a platform admin key.'
      : '';
    throw new Error(`manage_platform_tiers ${op} refused (${e.code ?? e.status}): ${e.error}${hint}`);
  }

  const was = r.before?.model ?? 'no platform default';
  const now = r.after?.model ?? 'no platform default';
  const verb = op === 'set' ? 'set' : op === 'apply' ? 'applied the suggestion' : op === 'clear' ? 'cleared' : 'reverted';
  const facts = r.facts ? ` (${priceLine(r.facts)}, ${floorLine(r.facts)})` : '';
  return (
    `Platform default for ${r.tier} ${verb}: ${was} → ${now}${facts}.\n` +
    `Teams without their own row now resolve ${r.tier} to ${r.effective.model} (source: ${SOURCE_TEXT[r.effective.source] ?? r.effective.source}); team and workspace rows are untouched, and a task pinned to an exact model id keeps it.\n` +
    `Takes effect on the next claim (within 60s). Audited; undo with action=revert tier=${r.tier} confirm=true.`
  );
}
