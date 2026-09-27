/**
 * `@buildd/ai-kit/decide`: Jev decisions (server; peer `@typesafe-ai/sdk`).
 *
 * P0 SKELETON: types only. The transport (one overall deadline, at most one
 * retry, never throws), `validateDecisionRequest`, `parseDecisionAnswers`,
 * `gateChoice`, `defineDecision` and `runDecisionEval` move here in P2.
 *
 * TODO(P2): these question/answer types are COPIED from buildd's
 * `packages/core/decision-client.ts`. P2 moves the pure parts here and makes
 * buildd import them, deleting the copy there.
 */

/** `instructions` and criteria descriptions may be a string, object or array. */
export type DecisionText = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion<L extends string = string> {
  type: 'choice';
  instructions: DecisionText;
  /** Label → definition (null when the label needs none). 2–255 labels. */
  criteria: Record<L, DecisionText | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionText;
  /** Ordered level descriptions, lowest first. 2–10 levels. */
  criteria: DecisionText[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionText;
  criteria?: { true?: DecisionText; false?: DecisionText };
}

export type DecisionQuestion = ChoiceQuestion<string> | ScoreQuestion | NoulQuestion;
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface ChoiceAnswer<L extends string = string> {
  type: 'choice';
  choice: L;
  probabilities: Record<L, number>;
  /** 0–1, derived by the provider from `probabilities`. */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; can land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability the answer is yes. Carries no `confidence`. */
  noul: number;
}

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L>
  : Q extends ScoreQuestion ? ScoreAnswer
  : Q extends NoulQuestion ? NoulAnswer
  : never;

export type DecisionAnswers<Q extends DecisionQuestions> = { [K in keyof Q]: AnswerFor<Q[K]> };

/**
 * - `shadow`: answers are persisted through `onDecision` and never acted on.
 * - `gated`: acts only above `minConfidence`; a gated `noul` needs an explicit probability threshold.
 * - `live`: for add-only uses.
 */
export type DecisionMode = 'shadow' | 'gated' | 'live';

export interface DecisionDefinition<Q extends DecisionQuestions = DecisionQuestions> {
  /** Stable id, namespaced by app: `app.decision_name`. */
  id: string;
  /** Bump when definitions or examples change. */
  promptVersion: string;
  questions: Q;
  mode: DecisionMode;
  minConfidence?: number;
}
