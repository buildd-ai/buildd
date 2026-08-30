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
    triageOutcome: {
      type: 'string',
      enum: ['single_task', 'multi_task', 'conflict'],
      description:
        'single_task: the mission needs one step. multi_task: it decomposes into several. conflict: the request ' +
        'contradicts existing work or itself and needs human input (surface it in questions).',
    },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'Short stable identifier for this step, unique within the plan (e.g. "design", "build-api", "review"). ' +
              'Other steps reference it in dependsOn. It is resolved to the real task id after the plan is approved.',
          },
          title: { type: 'string', description: 'Imperative one-line title for the task.' },
          description: {
            type: 'string',
            description:
              'Self-contained instructions for the agent that will execute this step. It runs in a fresh session ' +
              'with no memory of this plan, so state everything it needs.',
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Refs of steps that MUST finish before this one starts. Declare an edge whenever this step consumes ' +
              'another step\'s output — reviewing or testing its PR, building on its schema change, or documenting ' +
              'what it built. Steps you leave undeclared are treated as independent and become claimable ' +
              'IMMEDIATELY, so they can run at the same time as the step they depend on; the agent then finds no PR ' +
              'and the attempt is wasted. Only leave this empty when the step genuinely can run first.',
          },
          baseBranch: {
            type: 'string',
            description:
              'Ref of the step whose branch this one should build on, when it must continue that work rather than ' +
              'branch from the default. Usually paired with a dependsOn edge on the same ref.',
          },
          roleSlug: { type: 'string', description: 'Slug of the role/agent persona that should execute this step.' },
          outputRequirement: {
            type: 'string',
            description:
              'What this step must deliver: "pr_required" (code change), "artifact_required" (report/analysis), or "none".',
          },
          priority: { type: 'integer', description: 'Higher runs sooner among steps that are all unblocked.' },
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
    summary: {
      type: 'string',
      description: 'Brief explanation of the plan and the reasoning behind its ordering.',
    },
    missionComplete: {
      type: 'boolean',
      description:
        'True only when the mission goal is already fully satisfied and no further work is needed. ' +
        'When true, plan should be empty.',
    },
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
