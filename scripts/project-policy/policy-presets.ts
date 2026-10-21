import { createHash } from 'node:crypto';
import { canonicalJson } from '../../packages/ai-kit/src/decide';
import base from './product-language.json';
import gold from './gold.json';
import wwvd from './wwvd.json';
import type { ProjectPolicy } from './pipeline';

/** Explicit local user policy. Keep the original policy and benchmark unchanged. */
export function policyPreset(name = 'product-language'): { policy: ProjectPolicy; examples: typeof gold } {
  if (name === 'product-language') return { policy: base, examples: gold };
  if (name !== 'wwvd') throw new Error('Unknown policy preset. Use product-language or wwvd.');
  return { policy: { ...base, id: wwvd.id, version: wwvd.version,
    authority: { title: wwvd.authority, revision: wwvd.version,
      hash: createHash('sha256').update(canonicalJson({ baseAuthority: base.authority.hash, wwvd })).digest('hex'),
      criteria: wwvd.criteria, repoGuide: base.authority.repoGuide },
    semantic: { ...base.semantic, instructions: wwvd.instructions, labels: wwvd.labels, redundantCorrection: wwvd.redundantCorrection } }, examples: wwvd.examples };
}
