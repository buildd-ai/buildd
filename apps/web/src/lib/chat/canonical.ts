/** Deterministic JSON and hashing for approval binding. Pure (no DB). */

import { createHash } from 'crypto';
import { canonicalJson } from '@buildd/shared';

export { canonicalJson };

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
