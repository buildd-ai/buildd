/**
 * The PR-opened slot: the one decision a module contributes when a buildd
 * worker's PR opens. This file is the contract and has no runtime imports, so
 * modules can depend on it freely. See knowledge-base:
 * buildd/design/headless-core-and-modules.md.
 *
 * The GitHub webhook calls the slot on `pull_request.opened` (not a draft),
 * then decides the no-CI auto-merge itself. A policy that takes the PR (the
 * reviews module: a reviewer dispatched, a pre-flight escalation to a human, a
 * mechanical migration-renumber fix) answers `held: true`, and core does not
 * auto-merge it. It is a slot, not a subscriber, because core acts on the
 * answer: wired once in the composition root (`apps/web/src/modules.ts`
 * `PR_OPENED_POLICY`). A policy never throws; on failure it answers
 * `held: false` and core's own merge policy decides, as before.
 */
export interface PrOpenedInput {
  installationId: number;
  repoFullName: string;
  pr: { number: number; headSha: string; htmlUrl: string; baseRef: string | null; body: string | null };
  /** The newest worker row that owns the PR. */
  worker: { id: string; workspaceId: string; taskId: string; branch: string };
}

export interface PrOpenedVerdict {
  /** The module took the PR; core skips its no-CI auto-merge. */
  held: boolean;
}

export type PrOpenedPolicy = (input: PrOpenedInput) => Promise<PrOpenedVerdict>;
