import { describe, it, expect } from 'bun:test';
import {
  SIZE_BUCKET_DECISION,
  SIZE_BUCKET_ESTIMATES,
  SIZE_BUCKET_LABELS,
  SIZE_BUCKET_MIN_CONFIDENCE,
  expectedSizeForBucket,
} from '../task-size-bucket-decision';

describe('SIZE_BUCKET_DECISION', () => {
  it('is gated with a starting threshold (applies from the first PR; see module header)', () => {
    const policy = SIZE_BUCKET_DECISION.policyOf('bucket');
    expect(policy.mode).toBe('gated');
    expect(policy.minConfidence).toBe(SIZE_BUCKET_MIN_CONFIDENCE);
  });

  it('labels are exactly S / M / L', () => {
    expect(SIZE_BUCKET_LABELS).toEqual(['S', 'M', 'L']);
  });
});

describe('expectedSizeForBucket', () => {
  it('maps each bucket to its representative files/minutes, tagged source jev with the given confidence', () => {
    for (const bucket of SIZE_BUCKET_LABELS) {
      const result = expectedSizeForBucket(bucket, 0.8);
      expect(result).toEqual({ ...SIZE_BUCKET_ESTIMATES[bucket], source: 'jev', bucket, confidence: 0.8 });
    }
  });

  it('S < M < L in both files and minutes', () => {
    expect(SIZE_BUCKET_ESTIMATES.S.files).toBeLessThan(SIZE_BUCKET_ESTIMATES.M.files);
    expect(SIZE_BUCKET_ESTIMATES.M.files).toBeLessThan(SIZE_BUCKET_ESTIMATES.L.files);
    expect(SIZE_BUCKET_ESTIMATES.S.minutes).toBeLessThan(SIZE_BUCKET_ESTIMATES.M.minutes);
    expect(SIZE_BUCKET_ESTIMATES.M.minutes).toBeLessThan(SIZE_BUCKET_ESTIMATES.L.minutes);
  });
});
