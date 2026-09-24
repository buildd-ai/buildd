/**
 * The detector registry.
 *
 * Exactly the conditions a real incident justifies, and nothing speculative:
 * dispatch-stall and claim-error-rate from the overnight dispatch outage,
 * role-regression from a runner release that broke one role for most of a day.
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
import {
  createRoleRegression,
  roleRegression,
  type RoleRegressionThresholds,
} from './role-regression';

/** The registry at default thresholds. */
export const DETECTORS: readonly Detector[] = [dispatchStall, claimErrorRate, roleRegression];

/** The registry with configured thresholds — what the process actually runs. */
export function buildDetectors(opts: { roleRegression: RoleRegressionThresholds }): readonly Detector[] {
  return [dispatchStall, claimErrorRate, createRoleRegression(opts.roleRegression)];
}

export { claimErrorRate, dispatchStall, roleRegression };
