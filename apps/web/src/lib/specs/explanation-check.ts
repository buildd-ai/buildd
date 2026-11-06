import { explanationCoverage, type SpecExplanation } from '@buildd/spec-contract/explanation';
import { changeLines, criterionChanges, otherTextChanges, type ReviewRecord } from '@buildd/spec-contract/criterion-review';
import { otherTextBySection } from '@buildd/spec-contract/criterion-records';
import { hashedRecords } from './criteria';

const asReview = (body: string): ReviewRecord[] => hashedRecords(body).map((r) => ({ id: r.id, text: r.text, textHash: r.textHash, section: r.section, replaces: r.replaces }));

/**
 * Living Spec b7fc9316 R-28: what an agent's revise must cover is every change
 * between the approved revision and the new head, not only its own, so a stack
 * of unapproved revisions is explained once, on top. Uses explanationCoverage,
 * the check the approval page runs; no second check. Null when the explanation
 * covers it, or when nothing is approved to measure against.
 */
export function explanationRefusalText(approvedBody: string | null, newBody: string, explanation: SpecExplanation | null): string | null {
  if (approvedBody === null) return null;
  const lines = changeLines(criterionChanges(asReview(approvedBody), asReview(newBody)));
  const other = otherTextChanges(otherTextBySection(approvedBody), otherTextBySection(newBody));
  const cov = explanationCoverage(explanation, lines, other);
  if (cov.passed) return null;
  const ids = cov.notExplained.filter((i) => i.kind === 'criterion').map((i) => i.key);
  const headings = cov.notExplained.filter((i) => i.kind === 'section').map((i) => i.key || 'Before the first heading');
  const parts = [
    ids.length ? `criteria ${ids.join(', ')}` : '',
    headings.length ? `sections ${headings.map((h) => `"${h}"`).join(', ')}` : '',
  ].filter(Boolean).join(' and ');
  return `The explanation does not cover every change since the approved revision (${cov.line}). Not explained: ${parts}. Write one line for each, keyed by its id or heading, covering the changes of every unapproved revision below this one as well as your own (explanation.lines). Nothing was written.`;
}
