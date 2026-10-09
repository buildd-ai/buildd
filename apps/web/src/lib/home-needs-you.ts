import { deriveHomeAttention, homeAttentionCopy, waitsOnBuildd } from './home-attention';

/**
 * One deduplicated inbox and its copy, composed from data Home already loads.
 * `inProgress` counts the human reviews held back while Buildd still acts on
 * their PRs, for the quiet "also in progress" line; never part of `count`.
 */
export function deriveHomeNeedsYou(input: Parameters<typeof deriveHomeAttention>[0]) {
  const items = deriveHomeAttention(input);
  const prs = new Set<string>();
  for (const i of input.queue) {
    if (waitsOnBuildd(i)) {
      prs.add(i.prNumber != null && i.workspaceId ? `pr:${i.workspaceId}:${i.prNumber}` : i.subjectKey);
    }
  }
  return { items, inProgress: prs.size, ...homeAttentionCopy(items) };
}

// After an action, mobile uses the same copy derivation on the remaining list.
export { homeAttentionCopy, needsYouHeadline } from './home-attention';
export type { HomeAttentionItem } from './home-attention';
