/** Shared verdict-row builders for the criterion verdict acceptance suite. */
import type { CriterionVerdict, VerdictSource } from '../../../../../packages/spec-contract/src/outcome';

export const HEAD = 'a'.repeat(40);
export const OLD = 'b'.repeat(40);

export const row = (
  source: VerdictSource, criterionId: string, verdict: CriterionVerdict['verdict'], at: number, headSha: string | null = HEAD,
): CriterionVerdict => ({ criterionId, verdict, headSha, at: new Date(at), source });
export const test_ = (c: string, v: CriterionVerdict['verdict'], at: number, h: string | null = HEAD) => row('test', c, v, at, h);
export const review = (c: string, v: CriterionVerdict['verdict'], at: number, h: string | null = HEAD) => row('review', c, v, at, h);
