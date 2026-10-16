import type { SpecSource, SpecSourceKind } from './shapes';

/**
 * A spec home. Each home implements these four operations and nothing else;
 * approval, pinning, scope and verdicts never depend on which home it is.
 * I/O comes in through the implementation (an injected fetch, a store), so
 * this file stays free of any host.
 */
export interface SourceVersion {
  source: SpecSource;
  /** The frozen copy: Markdown, normalized when the home re-serializes (./hash.ts). */
  body: string;
  contentHash: string;
  author?: { kind: 'user' | 'agent'; id: string };
  createdAt?: string;
}

export interface ProposedChange {
  body: string;
  summary: string;
  /** The version the proposer read. A home refuses a proposal on a stale one. */
  baseVersion: string;
}

export type ProposeResult =
  | { ok: true; proposal: SpecSource }
  | { ok: false; reason: 'stale'; currentVersion: string }
  | { ok: false; reason: 'refused'; message: string };

export interface SpecSourceAdapter {
  readonly kind: SpecSourceKind;
  /** One version exactly, never "the latest" by accident. Null when it is gone. */
  readVersion(ref: string, version: string): Promise<SourceVersion | null>;
  /** Newest first. */
  listVersions(ref: string, opts?: { limit?: number }): Promise<Array<Pick<SourceVersion, 'source' | 'createdAt' | 'author'>>>;
  /**
   * An agent's change, written beside the spec, never over approved text (D-3):
   * a draft revision in buildd, a child page on a wiki, a branch in git.
   */
  proposeChange(ref: string, change: ProposedChange): Promise<ProposeResult>;
  /**
   * Versions newer than `since`, oldest first, for a host that polls. A home
   * with webhooks calls the host instead and may return an empty list.
   */
  versionsSince(ref: string, since: string): Promise<SpecSource[]>;
}
