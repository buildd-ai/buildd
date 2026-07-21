/**
 * Simple regex-based failure classifier.
 * Categorizes task failure errors to inform retry decisions.
 */

export type FailureClass = 'transient' | 'environmental' | 'logic' | 'budget_limited' | 'unknown';

/**
 * Classify a failure error string into a category:
 * - transient: network/capacity issues — retry likely helps
 * - environmental: wrong OS, missing framework — same environment = same failure
 * - logic: code bug or test failure — retry with different approach might help
 * - unknown: can't determine — treat conservatively
 */
export function classifyFailure(error: string): FailureClass {
  if (!error) return 'unknown';

  // Budget / session-limit exhaustion — not a code failure; task auto-resumes after reset.
  // Classified before other patterns so it isn't mistakenly labelled 'transient'.
  if (/session limit|hit your session|budget limit exceeded|out of extra usage|error_max_budget_usd|max budget/i.test(error)) return 'budget_limited';

  // Environmental — same environment = same failure, never retry
  if (/cannot find module|framework not found|canImport|linker error|no such module|xcrun|xcodebuild|platform.*not supported/i.test(error)) return 'environmental';
  if (/command not found|permission denied|EACCES/i.test(error)) return 'environmental';
  if (/import (CoreData|SwiftUI|UIKit|AppKit)/i.test(error)) return 'environmental';

  // Transient — retry likely helps
  if (/timeout|ECONNREFUSED|ECONNRESET|rate.limit|429|503|502|network|socket hang up/i.test(error)) return 'transient';
  if (/quota|capacity|overloaded/i.test(error)) return 'transient';

  // Logic — code bug, might fix with different approach
  if (/assertion|test failed|type error|undefined is not|cannot read prop|null reference/i.test(error)) return 'logic';
  if (/compile error|syntax error|type.*mismatch/i.test(error)) return 'logic';

  return 'unknown';
}

/**
 * Extract a usable error string from a task result object.
 */
export function extractErrorFromResult(result: Record<string, unknown> | null): string {
  if (!result) return '';
  return (result.summary as string) || (result.error as string) || '';
}
