/**
 * Shared, derived view of a ReadinessInput for the per-item detectors.
 * Pure.
 */

import { detectEcosystems, type DetectedEcosystem } from '../ecosystem-detect';
import type {
  DeploymentSignal,
  ItemStatus,
  ReadinessEvidence,
  ReadinessGitConfig,
  ReadinessInput,
  ReadinessItem,
  ReadinessItemId,
} from './types';

export interface ReadinessContext {
  /** No repository linked: nothing can be known. */
  noRepo: boolean;
  files: string[];
  truncated: boolean;
  manifests: Readonly<Record<string, string>>;
  deployments: DeploymentSignal[] | null;
  gitConfig: ReadinessGitConfig;
  configStatus: 'unconfigured' | 'admin_confirmed';
  releaseConfig: NonNullable<ReadinessInput['releaseConfig']> | null;
  branches: string[];
  ecosystems: DetectedEcosystem[];
  hasFile(path: string): boolean;
  hasDir(dir: string): boolean;
  /** A file exists but its contents were not supplied. */
  unreadable(path: string): boolean;
  /**
   * Status for "I looked for something and did not find it". A truncated or
   * absent tree cannot prove absence, so it reads `unknown` — never `missing`.
   */
  absentStatus(): Extract<ItemStatus, 'missing' | 'unknown'>;
  /** The evidence line for an unproven absence. */
  absentNote(what: string): ReadinessEvidence;
}

export function buildContext(input: ReadinessInput): ReadinessContext {
  const noRepo = input.files === null;
  const files = (input.files ?? []).map((f) => f.replace(/^\.\//, ''));
  const fileSet = new Set(files);
  const dirSet = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
  }
  const manifests = input.manifests ?? {};
  const truncated = input.truncated === true;
  return {
    noRepo,
    files,
    truncated,
    manifests,
    deployments: input.deployments ?? null,
    gitConfig: input.gitConfig ?? {},
    configStatus: input.configStatus ?? 'unconfigured',
    releaseConfig: input.releaseConfig ?? null,
    branches: input.branches ?? [],
    ecosystems: noRepo ? [] : detectEcosystems({ files, manifests }),
    hasFile: (p) => fileSet.has(p),
    hasDir: (d) => dirSet.has(d.replace(/\/$/, '')),
    unreadable: (p) => fileSet.has(p) && !(p in manifests),
    absentStatus: () => (truncated || noRepo ? 'unknown' : 'missing'),
    absentNote: (what) => ({
      kind: noRepo ? 'signal' : truncated ? 'signal' : 'absent',
      note: noRepo
        ? 'No repository is linked.'
        : truncated
          ? `${what} not found, but the repository tree was truncated so absence is not proven.`
          : `${what} not found.`,
    }),
  };
}

/** A reusable item for "no repository": every detector short-circuits to this. */
export function noRepoItem(
  base: Pick<ReadinessItem, 'id' | 'label' | 'importance'>,
): ReadinessItem {
  return {
    ...base,
    status: 'unknown',
    evidence: [{ kind: 'signal', note: 'No repository is linked.' }],
    fix: null,
  };
}

export type ItemBase = { id: ReadinessItemId; label: string; importance: 'core' | 'recommended' };

/** Wrap a detector so the no-repo case is handled once, here. */
export function detector(
  base: ItemBase,
  run: (ctx: ReadinessContext, base: ItemBase) => Omit<ReadinessItem, keyof ItemBase>,
): (ctx: ReadinessContext) => ReadinessItem {
  return (ctx) => (ctx.noRepo ? noRepoItem(base) : { ...base, ...run(ctx, base) });
}
