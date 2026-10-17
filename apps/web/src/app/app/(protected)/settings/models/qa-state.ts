/**
 * `?state=` fixture for Settings → Models, so the visual audit can see the
 * Decisions row's per-decision override list and its switch / Undo lines
 * (docs/specs/qa-capture-steps.md). The QA data's team has no override and no
 * switch, so only the current model ever renders there.
 *
 * `?state=decisions` replaces the overrides and switch lines with the ones
 * below. The row itself is a platform operator's, so capture with
 * `viewer=operator`. Display only: Undo and Save write nothing.
 *
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */

export interface DecisionModelOverrideFixture {
  kind: string;
  label: string;
  endpoint: 'systemone' | 'chat';
  model: string;
  via: 'openrouter' | 'litellm' | 'cloudflare';
}

export interface DecisionsQaFixture {
  overrides: DecisionModelOverrideFixture[];
  switches: { lines: Array<{ id: string; kind?: string; text: string }>; canUndo: boolean };
}

export const MODELS_QA_DECISIONS: DecisionsQaFixture = {
  overrides: [
    { kind: 'task_category', label: 'Task category', endpoint: 'chat', model: 'qwen3-8b', via: 'litellm' },
    { kind: 'buildd.orchestration_claim_hold', label: 'Start or wait', endpoint: 'systemone', model: 'clef', via: 'cloudflare' },
  ],
  switches: {
    lines: [{ id: 'qa-fixture-switch', kind: 'buildd.orchestration_claim_hold', text: 'Start or wait now uses Clef' }],
    canUndo: true,
  },
};

export function resolveModelsQaDecisions(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): DecisionsQaFixture | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'decisions' ? MODELS_QA_DECISIONS : null;
}
