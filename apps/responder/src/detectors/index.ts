/**
 * The detector registry.
 *
 * Exactly the two conditions the incident justifies, and nothing speculative.
 * A detector that has never been justified by a real failure is a false
 * positive waiting to happen, and one false positive is how a whole detector
 * suite gets muted.
 *
 * Adding one is three things, in this order: the failure that justifies it,
 * a threshold derived from an observed cadence rather than chosen, and a test
 * that evaluates it with no credential in the environment
 * (`index.test.ts` does that for every entry here automatically).
 */

import type { Detector } from '../types';
import { claimErrorRate } from './claim-error-rate';
import { dispatchStall } from './dispatch-stall';

export const DETECTORS: readonly Detector[] = [dispatchStall, claimErrorRate];

export { claimErrorRate, dispatchStall };
