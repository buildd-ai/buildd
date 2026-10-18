/**
 * Every conformance scenario a host runs: the original list, one scenario
 * per kernel-decided row of the docs/specs/workflow-state-kernel.md §16
 * matrix (matrix-scenarios.ts), and the library spec's incident sequences
 * (incident-scenarios.ts: #3787, #4663/#4670, the §15 #3754 replay, #4686).
 * The in-memory runner (conformance.test.ts) and buildd's Postgres runner
 * (apps/web/tests/db/workflow-kernel-conformance.test.ts) both iterate this
 * list, so a scenario added to any of the files runs on both.
 */
import { INCIDENT_SCENARIOS } from './incident-scenarios';
import { MATRIX_SCENARIOS } from './matrix-scenarios';
import { CONFORMANCE_SCENARIOS, type ConformanceScenario } from './scenarios';

export const ALL_CONFORMANCE_SCENARIOS: ConformanceScenario[] = [...CONFORMANCE_SCENARIOS, ...MATRIX_SCENARIOS, ...INCIDENT_SCENARIOS];
