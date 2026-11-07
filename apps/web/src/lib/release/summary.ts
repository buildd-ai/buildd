/**
 * The release summary review by risk asks a person to approve (spec 62e985a8
 * R-6, R-7). Pure; the reads are ./summary-store.ts.
 *
 * Nothing here names a branch or a strategy: the source, the target and the
 * method come from the workspace's own `releaseConfig` (and its integration
 * branch from `resolveTaskPrBase`), so `develop` into `release` by
 * `branch_merge` and `dev` by `workflow_dispatch` read the same way.
 */

import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { resolveReleaseStrategy } from '@buildd/core/release-strategy';
import { reviewByRiskOf, type ReviewByRiskArea } from '@buildd/shared';
import { REVIEW_BY_RISK_AREA_LABEL, workspaceIntegrationBranch } from '@/lib/review-by-risk';

type GitConfigLike = { mergePolicy?: unknown; targetBranch?: string | null; defaultBranch?: string | null } | null | undefined;

/** A workspace has a release step when its release config resolves to a strategy (R-6 terms). */
export function hasReleaseStep(releaseConfig: WorkspaceReleaseConfig | null | undefined): boolean {
  return resolveReleaseStrategy(releaseConfig ?? null).ok;
}

/**
 * Whether a release waits for a person to approve its summary: review by risk
 * on, a release step, and the workspace has not turned the approval off
 * (`releaseConfig.summaryApproval: false`). Any trigger, any strategy (AC-5).
 */
export function summaryApprovalRequired(gitConfig: GitConfigLike, releaseConfig: WorkspaceReleaseConfig | null | undefined): boolean {
  if (!reviewByRiskOf(gitConfig?.mergePolicy)) return false;
  if (!hasReleaseStep(releaseConfig)) return false;
  return releaseConfig?.summaryApproval !== false;
}

export interface ReleaseEnds {
  /** The branch the release ships from: the commit the summary describes is its head. */
  source: string;
  /** Where it lands, as the release config names it: a branch, or the workflow / script it runs. */
  target: string;
  strategy: 'branch_merge' | 'workflow_dispatch' | 'script';
  /** A branch to diff against for "merged since the last release", when the config names one. */
  targetBranch: string | null;
}

/**
 * The release's source and target exactly as the workspace's config gives
 * them. Null when there is no release step or no source branch can be named.
 */
export function releaseEnds(
  releaseConfig: WorkspaceReleaseConfig | null | undefined,
  gitConfig: GitConfigLike,
  repoDefaultBranch?: string | null,
): ReleaseEnds | null {
  const resolved = resolveReleaseStrategy(releaseConfig ?? null);
  if (!resolved.ok || !releaseConfig) return null;
  const integration = workspaceIntegrationBranch(gitConfig, repoDefaultBranch);
  const prod = releaseConfig.prodBranch?.trim() || null;
  const s = resolved.strategy;
  switch (s.kind) {
    case 'branch_merge': {
      const source = s.releaseBranch || integration;
      return source ? { source, target: s.prodBranch, strategy: s.kind, targetBranch: s.prodBranch } : null;
    }
    case 'workflow_dispatch':
      return { source: s.ref, target: prod ?? `workflow ${s.workflowFile}`, strategy: s.kind, targetBranch: prod };
    case 'script': {
      const source = s.ref || integration;
      return source ? { source, target: prod ?? `script \`${s.command}\``, strategy: s.kind, targetBranch: prod } : null;
    }
  }
  return null;
}

/** One PR merged into the source branch since the last release (R-7). */
export interface ReleaseSummaryItem {
  prNumber: number;
  title: string;
  /** The PR's one-line lede; the title when it carries none. */
  lede: string;
  /** R-4 areas it touched, and who approved it (null: a person, not recorded). */
  areas: Array<{ area: ReviewByRiskArea; approvedBy: string | null }>;
  spec: { specId: string; title: string | null; revision: number | null; criteria: string[] } | null;
  builtAhead: boolean;
  migrations: string[];
}

export interface ReleaseSummary {
  headSha: string;
  source: string;
  target: string;
  strategy: ReleaseEnds['strategy'];
  items: ReleaseSummaryItem[];
}

const flagged = (i: ReleaseSummaryItem) => i.builtAhead || i.areas.length > 0;

/** Built-ahead and R-4 items first, then the rest; newest first within each (input order kept). */
export function buildReleaseSummary(input: { headSha: string; ends: ReleaseEnds; items: readonly ReleaseSummaryItem[] }): ReleaseSummary {
  const items = [...input.items.filter(flagged), ...input.items.filter((i) => !flagged(i))];
  return { headSha: input.headSha, source: input.ends.source, target: input.ends.target, strategy: input.ends.strategy, items };
}

const STRATEGY_WORDS: Record<ReleaseEnds['strategy'], string> = {
  branch_merge: 'by merge',
  workflow_dispatch: 'by workflow',
  script: 'by script',
};

/** The summary as plain lines, for a page, a note or a refusal. */
export function releaseSummaryLines(s: ReleaseSummary): string[] {
  const lines = [`Release ${s.source} into ${s.target} ${STRATEGY_WORDS[s.strategy]}, at ${s.headSha.slice(0, 7)}: ${s.items.length} PR${s.items.length === 1 ? '' : 's'}.`];
  for (const i of s.items) {
    const tags: string[] = [];
    if (i.builtAhead) tags.push('built ahead of approval');
    for (const a of i.areas) tags.push(`${REVIEW_BY_RISK_AREA_LABEL[a.area]}, approved by ${a.approvedBy ?? 'a person'}`);
    if (i.spec) {
      const rev = i.spec.revision != null ? ` rev ${i.spec.revision}` : '';
      tags.push(`${i.spec.title ?? 'spec'}${rev}${i.spec.criteria.length ? `: ${i.spec.criteria.join(', ')}` : ''}`);
    }
    if (i.migrations.length) tags.push(`migration ${i.migrations.join(', ')}`);
    lines.push(`#${i.prNumber} ${i.lede}${tags.length ? ` (${tags.join('; ')})` : ''}`);
  }
  return lines;
}

export type ReleaseApprovalDecision =
  | { blocks: false }
  | { blocks: true; reason: string };

/**
 * Does this release wait? Approving releases exactly the commit it describes
 * (R-6): an approval of an older head does not cover a newer one.
 */
export function decideReleaseApproval(input: { required: boolean; headSha: string; approvedShas: readonly string[]; source?: string | null }): ReleaseApprovalDecision {
  if (!input.required) return { blocks: false };
  const head = input.headSha.toLowerCase();
  if (input.approvedShas.some((s) => s.toLowerCase() === head)) return { blocks: false };
  const older = input.approvedShas.length > 0 ? ' The summary a person approved describes an older commit, so this head needs a new one.' : '';
  return {
    blocks: true,
    reason: `release waits for a person to approve its summary for ${input.source ? `${input.source} at ` : ''}${head.slice(0, 7)} (review by risk).${older}`,
  };
}

