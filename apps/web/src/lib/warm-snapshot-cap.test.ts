import { describe, expect, test } from 'bun:test';
import { WARM_SNAPSHOT_MAX_BYTES_CEILING, resolveWarmSnapshotMaxBytes } from './warm-snapshot-cap';

describe('resolveWarmSnapshotMaxBytes', () => {
  test('a positive integer from gitConfig.warmSnapshot.maxBytes', () => {
    expect(resolveWarmSnapshotMaxBytes({ warmSnapshot: { maxBytes: 3 * 1024 ** 3 } })).toBe(3 * 1024 ** 3);
  });

  test('bounded above at 8 GiB', () => {
    expect(WARM_SNAPSHOT_MAX_BYTES_CEILING).toBe(8 * 1024 ** 3);
    expect(resolveWarmSnapshotMaxBytes({ warmSnapshot: { maxBytes: 64 * 1024 ** 3 } })).toBe(WARM_SNAPSHOT_MAX_BYTES_CEILING);
  });

  test.each([
    [null], [undefined], [{}], [{ warmSnapshot: null }], [{ warmSnapshot: {} }],
    [{ warmSnapshot: { maxBytes: 0 } }], [{ warmSnapshot: { maxBytes: -1 } }],
    [{ warmSnapshot: { maxBytes: 1.5 } }], [{ warmSnapshot: { maxBytes: '1000' } }],
    [{ warmSnapshot: { maxBytes: Number.POSITIVE_INFINITY } }],
  ])('unset or malformed (%p): null, so the dispatcher default applies', (gitConfig) => {
    expect(resolveWarmSnapshotMaxBytes(gitConfig)).toBeNull();
  });
});
