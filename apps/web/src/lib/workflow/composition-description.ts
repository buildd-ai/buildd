/**
 * The review-composition block of an integration, release or refresh PR's
 * description (docs/specs/workflow-state-kernel.md §13.13 rule 1). It keeps
 * four things apart so a reader never mistakes one for another:
 *
 *  1. reviewed constituent work: changes each reviewed and approved at its own head;
 *  2. composition verification: the mechanical proof that the final head is those
 *     changes and nothing else (or says it could not be proved);
 *  3. uncovered-delta review: the paths the proof did not cover, and whether a
 *     review of them is owed, running or done;
 *  4. final policy gate: CI, rails and open findings, which no review above lifts.
 *
 * Pure. The caller replaces the block between the markers; the rest of the PR
 * description is the author's.
 */
import type { CompositionAttestation } from './types';

export const COMPOSITION_BLOCK_START = '<!-- buildd:composition -->';
export const COMPOSITION_BLOCK_END = '<!-- /buildd:composition -->';

export interface CompositionBlockInput {
  attestation: CompositionAttestation;
  /** Why each non-constituent commit counted as novel. */
  novelCommits?: Array<{ sha: string; reason: string; paths: string[] }>;
  /** Review of the uncovered delta: not owed, owed (queued/running) or decided. */
  deltaReview?: 'not_owed' | 'pending' | 'approved' | 'changes_requested';
  /** Verification that could not decide, or was rejected by the kernel; a full review is owed instead. */
  rejectedBecause?: string[];
  gate: { state: string; openFindings: number; ci?: string | null };
}

const sh = (s: string) => s.slice(0, 7);

export function compositionBlock(i: CompositionBlockInput): string {
  const a = i.attestation;
  const unverifiable = a.novelDelta.result === 'unverifiable';
  const lines: string[] = [COMPOSITION_BLOCK_START, '## Review composition', ''];

  lines.push('### 1. Reviewed constituent work');
  if (a.constituents.length === 0) lines.push('None proved. This PR gets a full review.');
  for (const c of a.constituents) {
    lines.push(`- #${c.prNumber}: approved at \`${sh(c.reviewedHeadSha)}\`, landed as \`${sh(c.landedSha)}\``);
  }
  lines.push('');

  lines.push('### 2. Composition verification');
  if (unverifiable) lines.push(`Not proved: ${(a.novelDelta as { reason: string }).reason}. Nothing is claimed; a full review covers this PR.`);
  else if (i.rejectedBecause?.length) lines.push(`Rejected (${i.rejectedBecause.join(', ')}). A full review covers this PR.`);
  else lines.push(`Proved by ${a.method} against base \`${sh(a.baseSha)}\` at head \`${sh(a.aggregateHeadSha)}\`.`);
  lines.push('');

  lines.push('### 3. Uncovered-delta review');
  if (unverifiable || i.rejectedBecause?.length) lines.push('The whole PR (full review).');
  else if (a.novelDelta.result === 'none') lines.push('No uncovered delta: nothing here needs its own review.');
  else {
    lines.push(`Paths no earlier review covers (${i.deltaReview === 'approved' ? 'reviewed and approved' : i.deltaReview === 'changes_requested' ? 'reviewed, changes requested' : 'review owed'}):`);
    for (const p of a.novelDelta.paths.slice(0, 30)) lines.push(`- \`${p}\``);
    if (a.novelDelta.paths.length > 30) lines.push(`- and ${a.novelDelta.paths.length - 30} more`);
  }
  lines.push('');

  lines.push('### 4. Final policy gate');
  lines.push(`State: ${i.gate.state}. ${i.gate.openFindings ? `${i.gate.openFindings} open finding${i.gate.openFindings === 1 ? '' : 's'} block landing.` : 'No open findings.'} ${i.gate.ci ? `CI: ${i.gate.ci}.` : ''}`.trim());
  lines.push('Composition never replaces this gate: CI, merge rails and open findings still decide landing.');
  lines.push(COMPOSITION_BLOCK_END);
  return lines.join('\n');
}

/** The PR description with the composition block set; any earlier block is replaced, the rest kept. */
export function withCompositionBlock(body: string | null | undefined, block: string): string {
  const text = body ?? '';
  const a = text.indexOf(COMPOSITION_BLOCK_START);
  const b = text.indexOf(COMPOSITION_BLOCK_END);
  if (a >= 0 && b > a) return `${text.slice(0, a)}${block}${text.slice(b + COMPOSITION_BLOCK_END.length)}`;
  return text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`;
}
