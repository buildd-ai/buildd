/**
 * Workspace readiness — `computeReadiness(input)`.
 *
 * Pure: no fetch, no db, no clock, no fs. A file list plus a bounded map of
 * manifest contents in, a checklist out. Detection is generic — it recognises
 * toolchains and conventions by the files they leave, never by a repo's name or
 * layout. See docs/design/workspace-onboarding.md §2.
 *
 * `unknown` is load-bearing: anything that depends on a file the detector could
 * not see (truncated tree, unread manifest, detector not available) reports
 * `unknown`, never `missing`, so a scaffold is never proposed over real files.
 */

import { buildContext, type ReadinessContext } from './readiness/context';
import { detectBuildCommand, detectTestCommand, detectTypecheckCommand } from './readiness/commands';
import { detectEnvManifest, detectMigrationsDirItem } from './readiness/environment';
import { detectAgentInstructions } from './readiness/instructions';
import { detectMergePolicy } from './readiness/merge-policy';
import { detectReleasePath } from './readiness/release';
import { detectSpecFormat, detectSpecRoot, hasSpecs } from './readiness/specs';
import type { ReadinessInput, ReadinessItem, ReadinessItemId, ReadinessNextStep, ReadinessReport } from './readiness/types';
import { detectVisualQaSource } from './readiness/visual-qa';

export type {
  DeploymentSignal,
  FixKind,
  ItemStatus,
  ReadinessEvidence,
  ReadinessFix,
  ReadinessGitConfig,
  ReadinessInput,
  ReadinessItem,
  ReadinessItemId,
  ReadinessNextStep,
  ReadinessReleaseConfig,
  ReadinessReport,
} from './readiness/types';

const DETECTORS: Array<(ctx: ReadinessContext) => ReadinessItem> = [
  detectAgentInstructions,
  detectSpecRoot,
  detectSpecFormat,
  detectTestCommand,
  detectTypecheckCommand,
  detectBuildCommand,
  detectEnvManifest,
  detectMigrationsDirItem,
  detectMergePolicy,
  detectReleasePath,
  detectVisualQaSource,
];

/**
 * The first unmet step. `unknown` never advances or blocks a step: a step that
 * cannot be evaluated is not one the owner can act on (`truncated` tells them why).
 */
function nextStepFor(ctx: ReadinessContext, items: ReadinessItem[], hasMissions: boolean): ReadinessNextStep {
  if (ctx.noRepo) return 'link-repo';
  const live = (id: ReadinessItemId) => items.find((i) => i.id === id && !i.waived);

  if (ctx.configStatus !== 'admin_confirmed' && live('merge-policy')) return 'review-policy';

  const unmetCore = items.some((i) => i.importance === 'core' && i.id !== 'merge-policy' && i.status === 'missing' && !i.waived);
  if (unmetCore) return 'propose-fixes';

  if (live('spec-root')?.status === 'detected' && !ctx.truncated && !hasSpecs(ctx)) return 'author-spec';

  return hasMissions ? 'done' : 'first-mission';
}

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const ctx = buildContext(input);
  const waivers = ctx.gitConfig.onboarding?.waived ?? {};
  const items = DETECTORS.map((detect) => {
    const item = detect(ctx);
    const waived = waivers[item.id];
    return waived ? { ...item, waived } : item;
  });
  return {
    items,
    nextStep: nextStepFor(ctx, items, input.hasMissions === true),
    skill: 'workspace-onboarding',
    truncated: ctx.truncated,
  };
}
