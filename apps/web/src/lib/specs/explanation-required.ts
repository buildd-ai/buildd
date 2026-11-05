import { criterionRecords, otherTextBySection } from '@buildd/spec-contract/criterion-records';
import { changeLines, criterionChanges, otherTextChanges, type ReviewRecord } from '@buildd/spec-contract/criterion-review';
import { explanationCoverage, type SpecExplanation } from '@buildd/spec-contract/explanation';
import { criterionHash } from './criteria';

const records = (body: string): ReviewRecord[] => criterionRecords(body).map((r) => ({ id: r.id, text: r.text, textHash: criterionHash(r.text), section: r.section, replaces: r.replaces }));

/**
 * An agent's revision must explain every criterion and section it changes.
 * Reuses the approval page's coverage check (R-16), so the two never disagree.
 * Null when covered or nothing changed; otherwise the keys to add.
 */
export function explanationRefusal(prevBody: string, nextBody: string, explanation: SpecExplanation | null): { missing: string[]; message: string } | null {
  const lines = changeLines(criterionChanges(records(prevBody), records(nextBody)));
  const other = otherTextChanges(otherTextBySection(prevBody), otherTextBySection(nextBody));
  const coverage = explanationCoverage(explanation, lines, other);
  if (coverage.passed) return null;
  const missing = coverage.notExplained.map((i) => i.key);
  return {
    missing,
    message: `The explanation does not cover every change (${coverage.line}). Add a line to explanation.lines for: ${missing.join(', ')} (criterion id or section heading, one plain line each), then revise again. Nothing was written.`,
  };
}
