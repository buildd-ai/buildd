/**
 * Runner-side alias for the generic experiment-arm randomiser.
 *
 * The implementation moved to `@buildd/core/experiment-randomizer` when the
 * second experiment to need it (task-area prediction) turned out to draw its
 * arm server-side at claim time, where the runner's module graph is not
 * reachable. There is still exactly one copy of the draw — this file is a
 * re-export, not a fork. Two implementations of a version-salted draw that are
 * supposed to agree but are free to drift would make a unit's arm depend on
 * which process asked, which is the one property the salt exists to guarantee.
 *
 * Kept as a path so the runner's own import sites and
 * `apps/runner/__tests__/unit/experiment-randomizer.test.ts` keep resolving.
 */
export {
  assignExperimentArm,
  hashUnitInterval,
  resolveEnrolmentFraction,
} from '@buildd/core/experiment-randomizer';
export type {
  AssignExperimentArmArgs,
  ExperimentAssignment,
} from '@buildd/core/experiment-randomizer';
