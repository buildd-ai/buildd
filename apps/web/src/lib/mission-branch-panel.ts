/**
 * Pure rules for the mission footer's branch panel (spec f7f67f1a R-37).
 * Server-safe: page.tsx (a server component) decides whether to render the
 * client panel from these, so they must not live in the 'use client' module.
 */
import type { VisualReviewPresentation } from './workflow/visual-review-presentation';

/**
 * The branch, PR and commit line. A base branch alone says nothing the row
 * above it does not, so it is never a line on its own.
 */
export function branchPanelFacts(p: VisualReviewPresentation): string {
  const { branch } = p;
  const pr = branch.integrationPr ? `PR #${branch.integrationPr.number}` : null;
  const sha = branch.headSha ? branch.headSha.slice(0, 7) : null;
  if (!pr && !sha) return '';
  return [branch.base ? `into ${branch.base}` : null, pr, sha].filter(Boolean).join(' · ');
}

/**
 * Whether the panel has something of its own to offer: a person's action or
 * the problem report. Without one, its state line repeats the Screens row and
 * the checks, so the mission footer leaves it out.
 */
export function branchPanelHasAction(p: VisualReviewPresentation, readonly = false): boolean {
  return p.showPanel && !readonly && (!!p.owner || !!p.report);
}
