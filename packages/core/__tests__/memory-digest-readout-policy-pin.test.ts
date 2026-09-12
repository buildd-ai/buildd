import { describe, it, expect } from 'bun:test';
import { READOUT_POLICY_VERSION, CONTAMINATION_MARKER } from '../memory-digest-readout';

/**
 * The readout's notion of "which rows are comparable" must match the runner's.
 *
 * `READOUT_POLICY_VERSION` is a deliberate duplicate of the runner's
 * `MEMORY_DIGEST_POLICY_VERSION` (core must not depend on apps/runner). A
 * duplicate that selects the cohort is the worst kind to let drift: if the
 * runner bumps the version and this does not, the readout silently reports on
 * an empty cohort for ever. Nothing throws — the numbers just stop existing.
 *
 * Read with `Bun.file` rather than `readFileSync`: any file in a process that
 * mocks `fs` replaces it globally, and this assertion would then be made
 * against a stub. The contamination marker is pinned for the same reason — it
 * is a value produced by the runner's retrieval path, not a string this package
 * gets to choose.
 */
const RUNNER_POLICY = new URL('../../../apps/runner/src/memory-digest-policy.ts', import.meta.url).pathname;
const RUNNER_RETRIEVAL = new URL('../../../apps/runner/src/task-memory-retrieval.ts', import.meta.url).pathname;

describe('readout policy pin', () => {
  it('matches MEMORY_DIGEST_POLICY_VERSION in the runner', async () => {
    const src = await Bun.file(RUNNER_POLICY).text();
    const m = src.match(/export const MEMORY_DIGEST_POLICY_VERSION\s*=\s*'([^']+)'/);
    expect(m).not.toBeNull();
    expect(READOUT_POLICY_VERSION).toBe(m![1]);
  });

  it('pins a contamination marker the runner can actually emit', async () => {
    // If the marker is not a real `derivedBy` value the boundary can never be
    // derived, every run is indeterminate, and the readout cannot see at all.
    const src = await Bun.file(RUNNER_RETRIEVAL).text();
    expect(src).toContain(`'${CONTAMINATION_MARKER}'`);
  });
});
