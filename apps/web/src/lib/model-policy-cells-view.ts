/**
 * Words for the model policy cells on Settings → Model tiers. Everything here
 * reads the cells read model (`ModelPolicyCell` in @buildd/shared, served by
 * `GET /api/model-tiers/cells`); nothing derives state the server did not send.
 */
import type { ModelPolicyCell, ModelPolicyCellSource, ModelPolicyCellSurface, ModelPolicyDial } from '@buildd/shared';
import type { CatalogModel } from '@/lib/tier-mapping';
import { formatPrice } from '@/lib/model-picker';

export const SURFACE_LABEL: Record<ModelPolicyCellSurface, string> = { agent: 'Coding', chat: 'Chat' };

/** Footnote marker and text for a primary the team did not set itself. */
export const SOURCE_NOTE: Record<Exclude<ModelPolicyCellSource, 'team'>, { mark: string; text: string }> = {
  default: { mark: '*', text: 'buildd default' },
  service: { mark: '†', text: 'set by the policy service' },
  workspace: { mark: '‡', text: 'a workspace row' },
};

export function pctText(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Line 2 of a cell: its state, in words. */
export function cellStateText(cell: ModelPolicyCell): string {
  if (cell.state === 'always') return 'always this model';
  // Chat cells have no graded outcomes until chat learning reports them.
  if (cell.surface === 'chat' && cell.state !== 'shifted') return 'no quality signal';
  if (cell.state === 'learning') {
    return cell.progress ? `learning ${cell.progress.graded} of ${cell.progress.threshold}` : 'learning';
  }
  if (cell.state === 'shifted') {
    return `${cell.shiftedTo ?? 'alternate'} matches · ${pctText(cell.share ?? 0)} there`;
  }
  return `back to primary · ${cell.revertedFrom ?? 'alternate'} slipped`;
}

/** The plain-language status paragraph in the cell editor. */
export function learningParagraph(cell: ModelPolicyCell): string {
  const exp = cell.experimentRunning ? ' An experiment is running on this cell.' : '';
  if (cell.tier === 'premium-plus') return `Premium-plus always uses its primary.${exp}`;
  if (cell.alternates.length === 0) return `Every run uses the primary.${exp}`;
  if (cell.state === 'always') return `Every run uses the primary. Turn the dial up to let buildd try the others.${exp}`;
  if (cell.surface === 'chat' && cell.state !== 'shifted') {
    return `Every chat uses the primary. Chat has no quality signal yet, so traffic does not move.${exp}`;
  }
  if (cell.state === 'learning') {
    const p = cell.progress;
    if (!p) return `Every run uses the primary while buildd grades the others on your team's results.${exp}`;
    const eta = p.etaDays != null ? `, about ${Math.max(1, Math.round(p.etaDays))} days to go` : '';
    const who = p.candidate ?? 'the cheapest alternate';
    const note = p.note ? ` ${p.note}` : '';
    return `Every run uses the primary while buildd grades ${who} on your team's results: ${p.graded} of ${p.threshold} graded runs${eta}.${note}${exp}`;
  }
  if (cell.state === 'shifted') {
    return `${cell.shiftedTo ?? 'An alternate'} kept up with the primary, so it takes ${pctText(cell.share ?? 0)} of runs. If it slips, traffic goes back to the primary on its own.${exp}`;
  }
  const why = cell.revertReason ? ` (${cell.revertReason})` : '';
  return `${cell.revertedFrom ?? 'The alternate'} slipped${why}, so every run is back on the primary. Learning starts again after a cooldown.${exp}`;
}

/** Catalog entry for a registry or arm model id (an OpenRouter id matches too). */
export function catalogEntry(models: readonly CatalogModel[], model: string): CatalogModel | null {
  return models.find((m) => m.id === model || m.openRouterId === model) ?? null;
}

/** `$3/$15` per MTok, or null when the catalog has no price. */
export function priceText(models: readonly CatalogModel[], model: string): string | null {
  const m = catalogEntry(models, model);
  if (!m || m.inputPrice === undefined) return null;
  return `${formatPrice(m.inputPrice)}/${formatPrice(m.outputPrice)}`;
}

/** A cell routes when traffic can leave the primary: it has alternates, or more than one model ran. */
export function cellRoutes(cell: ModelPolicyCell): boolean {
  return cell.alternates.length > 0 || cell.whatRan.length > 1;
}

export const DIAL_LABEL: Record<ModelPolicyDial, string> = {
  1: 'always the primary',
  2: 'mostly the primary',
  3: 'balanced',
  4: 'lean to savings',
  5: 'cheapest that keeps up',
};
