/**
 * Every conformance scenario a host runs: the original list plus one scenario
 * per kernel-decided row of the docs/specs/workflow-state-kernel.md §16
 * matrix (matrix-scenarios.ts). The in-memory runner (conformance.test.ts)
 * and buildd's Postgres runner (apps/web/tests/db/workflow-kernel-conformance.test.ts)
 * both iterate this list, so a scenario added to either file runs on both.
 */
import { MATRIX_SCENARIOS } from './matrix-scenarios';
import { CONFORMANCE_SCENARIOS, type ConformanceScenario } from './scenarios';

export const ALL_CONFORMANCE_SCENARIOS: ConformanceScenario[] = [...CONFORMANCE_SCENARIOS, ...MATRIX_SCENARIOS];
