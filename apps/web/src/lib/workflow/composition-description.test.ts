import { describe, expect, test } from 'bun:test';
import { compositionBlock, withCompositionBlock, COMPOSITION_BLOCK_END, COMPOSITION_BLOCK_START } from './composition-description';
import type { CompositionAttestation } from './types';

const att = (novel: CompositionAttestation['novelDelta']): CompositionAttestation => ({
  repoFullName: 'a/b', prNumber: 9, baseSha: 'b'.repeat(40), aggregateHeadSha: 'a'.repeat(40), method: 'patch_set_equal', verifiedAt: 't', verifier: 'kernel',
  constituents: [{ deliveryId: 'd', roundId: 'r', prNumber: 3, reviewedHeadSha: 'c'.repeat(40), equivalentHeadShas: [], mergedHeadSha: 'c'.repeat(40), landedSha: 'd'.repeat(40), landedPatchId: 'e'.repeat(64), reviewedPatchId: 'e'.repeat(64) }],
  novelDelta: novel,
});
const gate = { state: 'AWAITING_REVIEW', openFindings: 0 };

describe('compositionBlock keeps the four things apart', () => {
  test('known composition, no delta', () => {
    const b = compositionBlock({ attestation: att({ result: 'none' }), gate });
    expect(b).toContain('### 1. Reviewed constituent work');
    expect(b).toContain('#3: approved at `ccccccc`');
    expect(b).toContain('Proved by patch_set_equal');
    expect(b).toContain('No uncovered delta');
    expect(b).toContain('### 4. Final policy gate');
  });
  test('novel delta lists paths and says a review is owed', () => {
    const b = compositionBlock({ attestation: att({ result: 'present', paths: ['x.ts'] }), deltaReview: 'pending', gate });
    expect(b).toContain('review owed');
    expect(b).toContain('- `x.ts`');
  });
  test('unknown composition claims nothing and owes a full review', () => {
    const b = compositionBlock({ attestation: att({ result: 'unverifiable', reason: 'commit_list_truncated' }), gate });
    expect(b).toContain('Not proved: commit_list_truncated');
    expect(b).toContain('The whole PR (full review)');
  });
  test('open findings show in the final gate, which composition never replaces', () => {
    const b = compositionBlock({ attestation: att({ result: 'none' }), gate: { state: 'CHANGES_REQUESTED', openFindings: 2 } });
    expect(b).toContain('2 open findings block landing');
    expect(b).toContain('never replaces this gate');
  });
});

describe('withCompositionBlock', () => {
  const block = `${COMPOSITION_BLOCK_START}\nnew\n${COMPOSITION_BLOCK_END}`;
  test('appends to an author body and replaces on rerun, keeping the rest', () => {
    const once = withCompositionBlock('Author text', block);
    expect(once.startsWith('Author text')).toBe(true);
    const twice = withCompositionBlock(once, `${COMPOSITION_BLOCK_START}\nnewer\n${COMPOSITION_BLOCK_END}`);
    expect(twice).toContain('newer');
    expect(twice).not.toContain('\nnew\n');
    expect(twice.match(new RegExp(COMPOSITION_BLOCK_START, 'g'))).toHaveLength(1);
  });
  test('an empty body is just the block', () => expect(withCompositionBlock(null, block).trim()).toBe(block));
});
