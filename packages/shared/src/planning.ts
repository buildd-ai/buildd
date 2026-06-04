// ============================================================================
// PLANNING CONTRACT
// ============================================================================
//
// Single source of truth for the orchestrator planning contract. This couples
// four boundaries that must agree or missions silently stall:
//
//   1. The runner requests SDK structured output using `planningOutputSchema`
//      (see resolveOutputFormat) so the plan comes back as validated JSON in
//      `result.structured_output` — NOT as free-form text the agent prints.
//   2. The agent is constrained to this schema by the SDK.
//   3. The worker reports `structuredOutput` to the server.
//   4. The server materializes `structuredOutput.plan` into child tasks
//      (approvePlan / resolveCompletedTask).
//
// Historically the schema lived only in an unused runner (packages/core/
// worker-runner.ts) while the live runner (apps/runner) never requested
// structured output for planning tasks — so the plan only ever existed as
// markdown text, no child tasks were created, and the mission loop re-planned
// forever. Keep this contract here, imported by both the runner and the web
// app, so the boundaries cannot drift apart again.

/**
 * A single step in an orchestrator plan. Superset of the fields the agent can
 * emit under {@link planningOutputSchema} plus fields only set programmatically
 * (model, skillSlugs, requiredCapabilities) when a plan is created/approved via
 * the API rather than by the planning agent.
 */
export interface PlanStep {
  ref: string;
  title: string;
  description: string;
  dependsOn?: string[];
  baseBranch?: string;
  roleSlug?: string;
  requiredCapabilities?: string[];
  outputRequirement?: string;
  priority?: number;
  /** Smart-routing hint — see plans/buildd/smart-model-routing.md */
  kind?: 'coordination' | 'engineering' | 'research' | 'writing' | 'design' | 'analysis' | 'observation';
  /** Smart-routing hint — see plans/buildd/smart-model-routing.md */
  complexity?: 'simple' | 'normal' | 'complex';
  /** Set programmatically (manual plan approval), not emitted by the planning agent. */
  model?: string;
  /** Set programmatically (manual plan approval), not emitted by the planning agent. */
  skillSlugs?: string[];
}

/** Open question the planning agent surfaces back to the mission for human input. */
export interface PlanQuestion {
  ref: string;
  question: string;
  context?: string;
  defaultChoice?: string;
}

/**
 * Validated structured output shape for a planning task. The SDK guarantees
 * this matches {@link planningOutputSchema} when outputFormat is set.
 */
export interface PlanningStructuredOutput {
  triageOutcome?: 'single_task' | 'multi_task' | 'conflict';
  plan: PlanStep[];
  summary: string;
  missionComplete: boolean;
  questions?: PlanQuestion[];
}

/**
 * JSON schema the SDK enforces on a planning task's final output. The agent is
 * constrained to produce exactly this shape, returned in `result.structured_output`.
 */
export const planningOutputSchema = {
  type: 'object',
  properties: {
    triageOutcome: { type: 'string', enum: ['single_task', 'multi_task', 'conflict'] },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          baseBranch: { type: 'string' },
          roleSlug: { type: 'string' },
          outputRequirement: { type: 'string' },
          priority: { type: 'integer' },
          // Smart-routing hints. Optional — router falls back to defaults
          // when absent. See plans/buildd/smart-model-routing.md.
          kind: {
            type: 'string',
            enum: ['coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation'],
          },
          complexity: {
            type: 'string',
            enum: ['simple', 'normal', 'complex'],
          },
        },
        required: ['ref', 'title', 'description'],
      },
    },
    summary: { type: 'string' },
    missionComplete: { type: 'boolean' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          question: { type: 'string' },
          context: { type: 'string' },
          defaultChoice: { type: 'string' },
        },
        required: ['ref', 'question'],
      },
    },
  },
  required: ['plan', 'summary', 'missionComplete'],
} as const satisfies Record<string, unknown>;

/** SDK structured-output request. Mirrors the agent SDK's json_schema outputFormat. */
export interface JsonSchemaOutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

/**
 * Resolve the SDK `outputFormat` for a task.
 *
 * Planning tasks ALWAYS get a schema so the plan returns as validated structured
 * output rather than free-form text — even when the task carries no explicit
 * `outputSchema` (which is the normal case for orchestrator-created planning
 * tasks). An explicit task schema always wins. Non-planning tasks without a
 * schema get no outputFormat.
 */
export function resolveOutputFormat(task: {
  mode?: string | null;
  outputSchema?: Record<string, unknown> | null;
}): JsonSchemaOutputFormat | undefined {
  const schema = task.outputSchema
    ?? (task.mode === 'planning' ? (planningOutputSchema as unknown as Record<string, unknown>) : undefined);
  return schema ? { type: 'json_schema', schema } : undefined;
}
