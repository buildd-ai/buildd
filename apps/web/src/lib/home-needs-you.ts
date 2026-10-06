import { deriveHomeAttention, homeAttentionCopy } from './home-attention';

/** One deduplicated inbox and its copy, composed from data Home already loads. */
export function deriveHomeNeedsYou(input: Parameters<typeof deriveHomeAttention>[0]) {
  const items = deriveHomeAttention(input);
  return { items, ...homeAttentionCopy(items) };
}

// After an action, mobile uses the same copy derivation on the remaining list.
export { homeAttentionCopy, needsYouHeadline } from './home-attention';
export type { HomeAttentionItem } from './home-attention';
