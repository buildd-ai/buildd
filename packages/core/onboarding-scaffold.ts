/**
 * Scaffold planner — which files an onboarding run proposes, rendered.
 *
 * Pure: readiness facts and the owner's chosen item ids in, rendered files plus
 * the reasons anything was left out. Nothing here writes, fetches or reads a
 * clock. docs/design/workspace-onboarding.md section 3.
 *
 * Safety rules, each one a place a scaffold could do damage:
 *   - only items the owner named are considered; no ids means no plan;
 *   - an item is proposed only when readiness proved it `missing` (or, for the
 *     two optional items, proved nothing contradicts it) — `unknown` and a
 *     truncated tree never yield a file, so nothing is proposed over real files;
 *   - a target path that already exists in the tree is never proposed;
 *   - a command that could not be detected renders `TODO(owner)`, never a guess.
 *
 * At most two PRs come out of a plan: `docs` (every non-CI item) and `release`
 * (the workflow, a different risk class), so `prs.length <= 2` by construction.
 */

import { findLockfileRule } from './ecosystem-detect';
import {
  renderOnboardingTemplate,
  type OnboardingParams,
  type OnboardingTemplateId,
} from './onboarding-render';
import { detectStartCommand } from './readiness/commands';
import { buildContext, type ReadinessContext } from './readiness/context';
import { computeReadiness } from './workspace-readiness';
import type { ReadinessInput, ReadinessItem, ReadinessItemId } from './workspace-readiness';

export const SCAFFOLD_ITEM_IDS = [
  'agent-instructions',
  'spec-root',
  'spec-format',
  'env-manifest',
  'release-path',
  'visual-qa-source',
] as const satisfies readonly ReadinessItemId[];

export type ScaffoldItemId = (typeof SCAFFOLD_ITEM_IDS)[number];
export type ScaffoldGroup = 'docs' | 'release';

export const SCAFFOLD_SKILL_SLUG = 'workspace-onboarding';

const DEFAULT_SPECS_ROOT = 'docs/specs';

export interface ScaffoldFile {
  group: ScaffoldGroup;
  /** Every selected item this one file satisfies (spec-root and spec-format share a file). */
  itemIds: ScaffoldItemId[];
  templateId: OnboardingTemplateId;
  path: string;
  content: string;
  commitMessage: string;
}

export interface ScaffoldSkip {
  itemId: string;
  reason: string;
}

export interface ScaffoldPr {
  group: ScaffoldGroup;
  title: string;
  paths: string[];
}

export interface ScaffoldPlan {
  files: ScaffoldFile[];
  skipped: ScaffoldSkip[];
  prs: ScaffoldPr[];
}

export interface ScaffoldPlanInput {
  itemIds: readonly string[];
  readiness: ReadinessInput;
  projectName: string;
  defaultBranch: string;
  isPublic?: boolean;
}

const COMMIT: Record<OnboardingTemplateId, string> = {
  instructions: 'docs: add agent instructions',
  'spec-format': 'docs: add spec format',
  'design-format': 'docs: add design format',
  'env-manifest': 'chore: add env manifest',
  'consumer-skill': 'docs: add buildd consumer skill',
  'visual-review': 'docs: add visual review skill',
  'release-workflow': 'ci: add release workflow',
};

const PR_TITLE: Record<ScaffoldGroup, string> = {
  docs: 'docs: add agent instructions and repo conventions',
  release: 'ci: add release workflow',
};

// Order files land in the docs PR: instructions first, since it names the rest.
const TEMPLATE_ORDER: OnboardingTemplateId[] = ['instructions', 'spec-format', 'env-manifest', 'visual-review', 'release-workflow'];

const TEMPLATE_FOR: Record<ScaffoldItemId, OnboardingTemplateId> = {
  'agent-instructions': 'instructions',
  'spec-root': 'spec-format',
  'spec-format': 'spec-format',
  'env-manifest': 'env-manifest',
  'release-path': 'release-workflow',
  'visual-qa-source': 'visual-review',
};

const isScaffoldItemId = (id: string): id is ScaffoldItemId => (SCAFFOLD_ITEM_IDS as readonly string[]).includes(id);

const UNPROVEN = 'cannot be proven absent (repository tree truncated or not readable), so nothing is scaffolded over files that might exist';

/** Why an item is not proposed, or null when it is eligible. */
function ineligible(item: ReadinessItem, ctx: ReadinessContext, input: ReadinessInput): string | null {
  if (item.waived) return `waived by the owner (${item.waived.reason})`;

  if (item.id === 'release-path') {
    if (input.releaseConfig?.enabled) return 'releases are already configured on the workspace';
    if (ctx.truncated) return UNPROVEN;
    if (item.status === 'detected' && !item.value?.startsWith('branch_merge:')) return 'already present (a release path was detected)';
    return null;
  }
  if (item.id === 'visual-qa-source') {
    if (ctx.truncated) return UNPROVEN;
    if (item.status === 'unknown') return 'cannot tell how UI is reviewed in this repo; decide the visual QA source first';
    if (item.status === 'detected' && item.value !== 'sandbox') return `already present (visual QA uses ${item.value ?? 'a preview source'})`;
    return null;
  }

  if (item.status === 'detected') return 'already present';
  if (item.status === 'unknown') return UNPROVEN;
  if (item.fix?.kind !== 'scaffold') return item.fix?.summary ?? 'needs an owner decision, not a scaffold';
  return null;
}

function commandOf(candidates: { command: string; confidence: string }[], onlyHigh = false): string | undefined {
  return candidates.find((c) => !onlyHigh || c.confidence === 'high')?.command;
}

function releaseBranches(item: ReadinessItem): { sourceBranch: string; targetBranch: string } | null {
  const cfg = (item.fix?.configPatch?.releaseConfig ?? null) as { releaseBranch?: string; prodBranch?: string } | null;
  if (cfg?.releaseBranch && cfg.prodBranch && cfg.releaseBranch !== cfg.prodBranch) {
    return { sourceBranch: cfg.releaseBranch, targetBranch: cfg.prodBranch };
  }
  return null;
}

export function planScaffold(input: ScaffoldPlanInput): ScaffoldPlan {
  const ids = [...new Set(input.itemIds)];
  if (ids.length === 0) return { files: [], skipped: [], prs: [] };

  const report = computeReadiness(input.readiness);
  const ctx = buildContext(input.readiness);
  const byId = new Map(report.items.map((i) => [i.id as string, i]));
  const skipped: ScaffoldSkip[] = [];
  const eligible: ScaffoldItemId[] = [];

  for (const id of ids) {
    if (!isScaffoldItemId(id)) {
      skipped.push({ itemId: id, reason: 'not a scaffoldable item; nothing to scaffold for it' });
      continue;
    }
    const item = byId.get(id);
    const reason = item ? ineligible(item, ctx, input.readiness) : 'not in the readiness report';
    if (reason) skipped.push({ itemId: id, reason });
    else eligible.push(id);
  }

  // Spec root: an existing one wins, else the first scaffolded one lands at the default.
  const specRootItem = byId.get('spec-root');
  const specsRoot =
    specRootItem?.status === 'detected' && specRootItem.value ? specRootItem.value : DEFAULT_SPECS_ROOT;
  const willHaveSpecs = (specRootItem?.status === 'detected') || eligible.includes('spec-root') || eligible.includes('spec-format');

  const eco = ctx.ecosystems.find((e) => e.lockfile) ?? ctx.ecosystems[0];
  const migrations = byId.get('migrations-dir');

  const paramsFor = (templateId: OnboardingTemplateId, item: ReadinessItem | undefined): OnboardingParams | null => {
    switch (templateId) {
      case 'instructions':
        return {
          projectName: input.projectName,
          defaultBranch: input.defaultBranch,
          installCommand: eco && commandOf(eco.install),
          testCommand: eco && commandOf(eco.test),
          typecheckCommand: eco && commandOf(eco.typecheck),
          buildCommand: eco && commandOf(eco.build),
          migrationsDir: migrations?.status === 'detected' ? migrations.value : undefined,
          specsRoot: willHaveSpecs ? specsRoot : undefined,
          isPublic: input.isPublic === true,
          consumerSkill: ctx.hasFile('.claude/skills/buildd-mcp-consumer/SKILL.md'),
        };
      case 'spec-format':
        return { specsRoot };
      case 'env-manifest': {
        const rule = eco?.lockfile ? findLockfileRule((l) => l === eco.lockfile) : null;
        return {
          runtime: rule?.runtime,
          installCommand: eco && commandOf(eco.install),
          readinessCommand: eco && (commandOf(eco.typecheck, true) ?? commandOf(eco.test, true)),
        };
      }
      case 'visual-review':
        return { projectName: input.projectName, startCommand: detectStartCommand(ctx)?.command };
      case 'release-workflow': {
        const branches = item ? releaseBranches(item) : null;
        return branches;
      }
      default:
        return null;
    }
  };

  const merged = new Map<OnboardingTemplateId, ScaffoldItemId[]>();
  for (const id of eligible) {
    const tpl = TEMPLATE_FOR[id];
    merged.set(tpl, [...(merged.get(tpl) ?? []), id]);
  }

  const files: ScaffoldFile[] = [];
  for (const templateId of TEMPLATE_ORDER) {
    const itemIds = merged.get(templateId);
    if (!itemIds) continue;
    const params = paramsFor(templateId, byId.get(itemIds[0]));
    if (!params) {
      for (const id of itemIds) {
        skipped.push({ itemId: id, reason: 'no long-lived source and target branch pair detected; decide the release path first' });
      }
      continue;
    }
    const rendered = renderOnboardingTemplate(templateId, params);
    if (ctx.hasFile(rendered.path)) {
      for (const id of itemIds) skipped.push({ itemId: id, reason: `${rendered.path} already exists; not overwritten` });
      continue;
    }
    files.push({
      group: templateId === 'release-workflow' ? 'release' : 'docs',
      itemIds,
      templateId,
      path: rendered.path,
      content: rendered.content,
      commitMessage: COMMIT[templateId],
    });
  }

  const prs: ScaffoldPr[] = (['docs', 'release'] as const)
    .map((group) => ({ group, title: PR_TITLE[group], paths: files.filter((f) => f.group === group).map((f) => f.path) }))
    .filter((p) => p.paths.length > 0);

  return { files, skipped, prs };
}

/** The task description: the rendered files as a starting point, and the rules the PRs follow. */
export function buildScaffoldTaskDescription(plan: ScaffoldPlan, opts: { defaultBranch: string }): string {
  const fence = (f: ScaffoldFile) => {
    const ticks = '`'.repeat(Math.max(3, ...[...f.content.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `### \`${f.path}\` (commit: \`${f.commitMessage}\`)\n\n${ticks}\n${f.content.replace(/\n$/, '')}\n${ticks}`;
  };
  const docs = plan.files.filter((f) => f.group === 'docs');
  const release = plan.files.filter((f) => f.group === 'release');

  const lines = [
    'Set this repository up for buildd workers by adding the files below. The owner selected each one and reviews the PR before it merges.',
    '',
    '## How to work',
    '',
    'The rendered files are a starting point, not the answer. Verify each against the repo, then adjust: run every command the file names and confirm it works, check every path it mentions exists, and replace each `TODO(owner)` you can resolve from the repo (leave it, and say so in the PR, when you cannot). Do not paste a file unread.',
    '',
    '## PRs',
    '',
    `- Base every PR on \`${opts.defaultBranch}\` and work on your task branch. Never commit or push to the default branch \`${opts.defaultBranch}\`.`,
  ];
  if (docs.length > 0) {
    lines.push(`- One docs PR holding ${docs.length === 1 ? 'the file' : 'every docs file'} below, with one commit per item, using the commit message shown.`);
  }
  if (release.length > 0) {
    lines.push('- The release workflow goes in a separate PR: it changes CI and deploy config, which deserves its own review.');
  }
  lines.push(
    '- Open at most these PRs, nothing else. Do not merge them: a human reviews and merges every scaffold PR.',
    '',
    `Use the \`${SCAFFOLD_SKILL_SLUG}\` skill for the onboarding conventions.`,
    '',
    '## Files',
    '',
    ...plan.files.flatMap((f) => [fence(f), '']),
  );
  return lines.join('\n').replace(/\n+$/, '\n');
}
