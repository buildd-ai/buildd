import type { Verdict } from './outcome';

/**
 * The portable records of Living Specs. Each keys on a spec revision: an
 * approval is a property of a revision, not a separate id (D-6). A host keeps
 * them in its own store; these are the fields another host must be able to
 * read back.
 */

/** Where a spec's text lives. One home per spec; nothing syncs between homes (D-1). */
export const SPEC_SOURCE_KINDS = ['buildd', 'confluence', 'git'] as const;
export type SpecSourceKind = (typeof SPEC_SOURCE_KINDS)[number];

/**
 * One version of a spec's text in its home: buildd's own revision number, a
 * wiki page id and its version number, or a repo path at a full commit SHA.
 */
export interface SpecSource {
  kind: SpecSourceKind;
  /** buildd: the spec id; confluence: the page id; git: `owner/repo:path`. */
  ref: string;
  /** buildd and confluence: the version number as a string; git: the commit SHA. */
  version: string;
}

/**
 * The design a revision is built to (D-8). Tool-agnostic: the default is a
 * design stored as an artifact (an HTML or code prototype, or images) at one
 * of its revisions; a URL or a design-file tool is another kind behind the
 * same shape.
 */
export const DESIGN_KINDS = ['artifact', 'url', 'figma'] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

export interface DesignScreen {
  /** Stable within the design: a route, a frame or node id, a file name. */
  id: string;
  name: string;
}

export interface DesignRef {
  kind: DesignKind;
  ref: string;
  version: string;
  /** The screens a criterion may name, so a checker knows what each one covers. */
  screens?: DesignScreen[];
}

/** A person put one revision in force (D-2). Written once. */
export interface ApprovalRecord {
  specId: string;
  revision: number;
  source: SpecSource;
  contentHash: string;
  design?: DesignRef;
  approvedBy: string;
  approvedAt: string;
}

/**
 * Work fixed to one approved revision. The server writes it when work starts;
 * a caller's revision or hash is never trusted. `criteria` narrows what the
 * work answers for; absent, it answers for every criterion.
 */
export interface SpecPin {
  specId: string;
  specRevisionId: string;
  revision: number;
  contentHash: string;
  criteria?: string[];
}

/** Pointer to evidence, never the evidence itself. */
export interface EvidenceRef {
  /** e.g. `screenshot`, `capture`, `step-log`, `design`, `read`, `check-run`. */
  kind: string;
  ref: string;
}

/** Who graded: the code reviewer, a check line's run, the visual auditor, a person. */
export const CHECKERS = ['reviewer', 'check', 'visual', 'person'] as const;
export type Checker = (typeof CHECKERS)[number];

/**
 * One verdict on one criterion, bound to the commit it judged. Append-only:
 * a new commit gets new verdicts, the old ones stay, and the newest per
 * criterion stands (D-7). The work's own run never writes one (D-5).
 */
export interface SpecVerdict {
  taskId: string;
  specRevisionId: string;
  criterionId: string;
  verdict: Verdict;
  headSha: string;
  evidence: EvidenceRef[];
  checker: Checker;
}
