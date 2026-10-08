/**
 * Labelled claim-time overlap scenarios for replaying HOLD/START policies
 * (packages/core/orchestration-claim-risk-eval.ts).
 *
 * Synthetic by construction: every path, id, time and minute count is
 * invented to reproduce a SHAPE seen in practice, never a figure from
 * production. Real sampled outcomes (with counts) live in the private
 * knowledge base; add a shape here, not a row.
 *
 * Splits are frozen: tune on `train`, report on `heldout`, re-check on `later`.
 */
import type { ClaimRiskScenario } from '../../orchestration-claim-risk-eval';
import { summarizeFileConflictHistory } from '../../orchestration-claim-decision';

export const SCENARIO_NOW = '2026-10-01T12:00:00.000Z';
const ago = (m: number) => new Date(Date.parse(SCENARIO_NOW) - m * 60_000).toISOString();
const history = (path: string, mergedPrs: number, conflicted: number) =>
  summarizeFileConflictHistory([path], [{ path, mergedPrs, conflicted }]);

const base = {
  gate: 'soft_overlap' as const,
  rail: null,
  now: SCENARIO_NOW,
};

export const CLAIM_RISK_SCENARIOS: ClaimRiskScenario[] = [
  // ── Stale mission-branch refresh ──────────────────────────────────────────
  // A "merge dev into the mission branch" PR inherits hundreds of files in its
  // three-dot diff and task manifest; its own change at head is a handful of
  // conflict resolutions. New work on an unrelated file must not wait on it.
  {
    id: 'stale-refresh-disjoint-at-head', split: 'train', shape: 'stale_mission_refresh',
    input: {
      ...base, gate: 'open_pr_overlap', holderState: 'ended',
      candidatePaths: ['apps/web/src/lib/billing/invoice.ts'],
      overlapPaths: ['apps/web/src/lib/billing/invoice.ts'],
      holderScope: { source: 'pr_diff_at_head', paths: ['apps/web/src/app/page.tsx', 'docs/specs/INDEX.md'], headSha: 'h1', currentHeadSha: 'h1', observedAt: ago(4) },
    },
    outcome: 'clean_merge_tree', waitMinutes: 240,
  },
  {
    id: 'stale-refresh-head-moved', split: 'heldout', shape: 'stale_mission_refresh',
    input: {
      ...base, gate: 'open_pr_overlap', holderState: 'ended',
      candidatePaths: ['apps/web/src/lib/billing/invoice.ts'],
      overlapPaths: ['apps/web/src/lib/billing/invoice.ts'],
      // Computed at an older head: not trusted, the model judges.
      holderScope: { source: 'pr_diff_at_head', paths: ['apps/web/src/app/page.tsx'], headSha: 'h1', currentHeadSha: 'h2', observedAt: ago(4) },
    },
    outcome: 'censored_held', waitMinutes: 180,
  },
  {
    id: 'stale-refresh-real-overlap-at-head', split: 'heldout', shape: 'stale_mission_refresh',
    input: {
      ...base, gate: 'open_pr_overlap', holderState: 'ended',
      candidatePaths: ['apps/web/src/app/page.tsx'],
      overlapPaths: ['apps/web/src/app/page.tsx'],
      holderScope: { source: 'pr_diff_at_head', paths: ['apps/web/src/app/page.tsx'], headSha: 'h3', currentHeadSha: 'h3', observedAt: ago(2) },
    },
    outcome: 'rebase_required', waitMinutes: 60,
  },

  // ── Same ordinary file, separate regions ──────────────────────────────────
  {
    id: 'same-file-separate-regions-probe-clean', split: 'train', shape: 'same_file_separate_regions',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/format.ts'], overlapPaths: ['apps/web/src/lib/format.ts'],
      probe: { outcome: 'clean', conflictFiles: [], probedAt: ago(10), headsCurrent: true },
    },
    outcome: 'clean_merge_tree', waitMinutes: 90,
  },
  {
    id: 'same-file-low-history', split: 'heldout', shape: 'same_file_separate_regions',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/format.ts'], overlapPaths: ['apps/web/src/lib/format.ts'],
      history: history('apps/web/src/lib/format.ts', 40, 1),
    },
    outcome: 'clean_merge_tree', waitMinutes: 75,
  },
  {
    id: 'same-file-mergiraf', split: 'later', shape: 'same_file_structural',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/routes.ts'], overlapPaths: ['apps/web/src/lib/routes.ts'],
      probe: { outcome: 'mergiraf_resolved', conflictFiles: [], probedAt: ago(15), headsCurrent: true },
    },
    outcome: 'mergiraf_resolved', waitMinutes: 45,
  },

  // ── Genuine collision ─────────────────────────────────────────────────────
  {
    id: 'same-file-probe-conflict', split: 'train', shape: 'genuine_collision',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/claim.ts'], overlapPaths: ['apps/web/src/lib/claim.ts'],
      probe: { outcome: 'conflict', conflictFiles: ['apps/web/src/lib/claim.ts'], probedAt: ago(5), headsCurrent: true },
    },
    outcome: 'git_conflict', repairMinutes: 50,
  },
  {
    id: 'same-file-high-history', split: 'heldout', shape: 'genuine_collision',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/hot.ts'], overlapPaths: ['apps/web/src/lib/hot.ts'],
      history: history('apps/web/src/lib/hot.ts', 12, 8),
    },
    outcome: 'git_conflict', repairMinutes: 40,
  },
  {
    id: 'same-file-no-history-conflicted', split: 'later', shape: 'genuine_collision',
    input: {
      ...base, overlapKind: 'same_file', holderState: 'live',
      candidatePaths: ['apps/web/src/lib/new.ts'], overlapPaths: ['apps/web/src/lib/new.ts'],
    },
    outcome: 'human_intervention', repairMinutes: 90,
  },
  {
    id: 'clean-merge-semantic-regression', split: 'later', shape: 'semantic_regression',
    input: {
      ...base, overlapKind: 'prefix', holderState: 'live',
      candidatePaths: ['packages/core/limits/'], overlapPaths: ['packages/core/limits/'],
    },
    outcome: 'ci_semantic_regression', repairMinutes: 30,
  },

  // ── Hard rails ────────────────────────────────────────────────────────────
  {
    id: 'migration-index-collision', split: 'train', shape: 'hard_rail',
    input: { ...base, rail: 'migration', overlapKind: 'same_file', holderState: 'live', candidatePaths: ['packages/core/drizzle/0300_x.sql'], overlapPaths: ['packages/core/drizzle/0300_x.sql'] },
    outcome: 'migration_index_collision', repairMinutes: 60,
  },
  {
    id: 'generated-file', split: 'heldout', shape: 'hard_rail',
    input: { ...base, rail: 'serialized_surface', overlapKind: 'same_file', holderState: 'live', candidatePaths: ['docs/specs/INDEX.md'], overlapPaths: ['docs/specs/INDEX.md'] },
    outcome: 'censored_held', waitMinutes: 30,
  },
  {
    id: 'live-lease', split: 'later', shape: 'hard_rail',
    input: { ...base, rail: 'live_lease', overlapKind: 'same_file', holderState: 'live', candidatePaths: ['apps/web/src/lib/a.ts'], overlapPaths: ['apps/web/src/lib/a.ts'] },
    outcome: 'censored_held', waitMinutes: 20,
  },
  {
    id: 'unknown-state', split: 'later', shape: 'hard_rail',
    input: { ...base, rail: 'state_unresolved', overlapKind: 'prefix', holderState: null, candidatePaths: ['apps/web/src/lib/a.ts'], overlapPaths: ['apps/web/src/lib/'] },
    outcome: 'censored_held', waitMinutes: 5,
  },

  // ── Nothing in flight / directory only ────────────────────────────────────
  {
    id: 'holder-never-started', split: 'train', shape: 'queued_holder',
    input: { ...base, overlapKind: 'prefix', holderState: 'not_started', candidatePaths: ['scripts/'], overlapPaths: ['scripts/', 'scripts/release.sh'] },
    outcome: 'clean_merge_tree', waitMinutes: 600,
  },
  {
    id: 'directory-only-live-holder', split: 'heldout', shape: 'directory_only',
    input: { ...base, overlapKind: 'prefix', holderState: 'live', candidatePaths: ['apps/web/src/components/'], overlapPaths: ['apps/web/src/components/'] },
    outcome: 'clean_merge_tree', waitMinutes: 120,
  },

  // ── The shadow cohort shape: held, never started, no counterfactual ───────
  {
    id: 'shadow-held-open-pr', split: 'train', shape: 'shadow_censored',
    input: { ...base, gate: 'open_pr_overlap', holderState: 'ended', candidatePaths: ['apps/web/src/lib/a.ts'], overlapPaths: ['apps/web/src/lib/a.ts'] },
    outcome: 'censored_held', waitMinutes: 300,
  },
  {
    id: 'shadow-held-undeclared', split: 'train', shape: 'shadow_censored',
    input: { ...base, gate: 'advisory_manifest', holderState: null, candidatePaths: [], overlapPaths: [] },
    outcome: 'censored_held', waitMinutes: 200,
  },
];
