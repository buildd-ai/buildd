/**
 * A GithubFactReader that answers from one recorded fact instead of GitHub.
 *
 * `ingestFact` takes its own live reads (R2) and stores what it read in the
 * fact's payload: the PR (`live`), the §9 proof and §6.9 attribution answers
 * from the compare API, the carry-forward verdict and, for a close, whether the
 * base branch still exists. Replaying the fact hands those answers back.
 *
 * Why not the stateful fake (./fake-github.ts): replay must hand back exactly
 * what was read, for opaque recorded SHAs whose history the corpus does not
 * carry. The fake mints its own SHAs from a commit graph, so it cannot be told
 * "this pseudonymous head contains that one". The two meet one level up: the
 * synthetic corpus is recorded against the fake (tests/db/kernel-corpus-seed.ts),
 * and this reader replays it. `replayDelivery` only needs some GithubFactReader
 * per fact, so either can stand in.
 *
 * A read the recording never answered throws `UnansweredRead`, so the replay
 * reports it instead of guessing.
 */
import type { LivePr } from '../commands';
import type { GithubFactReader } from '../facts';
import type { KernelView } from '../types';

export class UnansweredRead extends Error {
  constructor(readonly read: string) {
    super(`the recording does not answer ${read}`);
    this.name = 'UnansweredRead';
  }
}

type J = Record<string, unknown>;

/**
 * `view` is the replay's delivery before the fact is applied: the compare
 * calls are told apart by their ancestor argument, exactly as `commandFor`
 * chooses them (the bound attempt's local head → proof, the held head with no
 * local → content changed, the bound head → attribution).
 */
export function recordedReader(payload: J, view: KernelView): GithubFactReader {
  const live = (payload.live ?? null) as LivePr | null;
  const proof = (payload.proof ?? null) as { liveContainsLocal?: boolean; contentDiffChanged?: boolean } | null;
  const attribution = (payload.attribution ?? null) as { descendsFromBound?: boolean } | null;
  const d = view.delivery;
  const bound = view.attempts.find((a) => a.id === d?.boundAttemptId);
  const local = bound?.reportedShas.at(-1) ?? d?.pushPendingLocalHead ?? null;

  return {
    async readPr() {
      if (!live) throw new UnansweredRead('readPr (no live PR in the fact payload)');
      return live;
    },
    async contains(_repo, ancestor) {
      if (local && ancestor === local && proof && typeof proof.liveContainsLocal === 'boolean') return proof.liveContainsLocal;
      if (!local && ancestor === d?.currentHeadSha && proof && typeof proof.contentDiffChanged === 'boolean') return proof.contentDiffChanged;
      if (ancestor === bound?.boundHeadSha && attribution && typeof attribution.descendsFromBound === 'boolean') return attribution.descendsFromBound;
      throw new UnansweredRead(`contains(${ancestor} in live head)`);
    },
    async contentEquivalent() {
      // A recorded carry-forward means the compare said "same change". Without
      // one the original either read "not equivalent" or never asked; both are
      // `null`/false to carryForwardEvidence, which fails closed on anything but true.
      return payload.carryForward === 'content_equivalent' || payload.carryForward === 'own_refresh' ? true : null;
    },
    async branchExists() {
      return typeof payload.baseExists === 'boolean' ? payload.baseExists : null;
    },
    async ciGreen() { throw new UnansweredRead('ciGreen'); },
    async checkRuns() { throw new UnansweredRead('checkRuns'); },
    async branchHead() { throw new UnansweredRead('branchHead'); },
    async failingChecks() { throw new UnansweredRead('failingChecks'); },
  };
}
