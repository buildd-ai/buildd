/** Distinct tasks that must share a failure before it is an incident. */
export const MIN_TASKS = 3;

/** Exits that are a decision, not a failure. */
export const NON_FAILURE_EXITS = new Set(['cancelled', 'superseded']);
