/**
 * CBM search injection — which factual list to show, or none
 * (docs/design/cbm-search-injection.md, Flow 4).
 *
 * Asked only after the runner's deterministic diff found graph locations the
 * agent's search did not show. The model never writes text: it picks between
 * two lists the runner already computed, or neither.
 *
 * State is structured facts only (`CbmInjectionFacts`): no command, pattern,
 * symbol name, path or content ever reaches the model.
 *
 * Gated at a provisional threshold. Below it — and on any failure — the runner
 * injects callers: Max chose live injection, and the diff is factual and capped.
 */
import { choice, defineDecision, type DecisionRun } from '@builddai/ai-kit/decide';
import type { CbmInjectionAction, CbmInjectionDecisionReply, CbmInjectionFacts } from './cbm-injection';

export const CBM_INJECTION_PROMPT_VERSION = 'csi1';

/**
 * Provisional, not from a held-out eval: there is no labelled data until the
 * uptake signal exists (spec, open question 2). Re-tune from uptake per label,
 * then bump the prompt version.
 */
export const CBM_INJECTION_MIN_CONFIDENCE = 0.6;

/** Server-side deadline. The runner aborts the HTTP request at 1s. */
export const CBM_INJECTION_DECISION_TIMEOUT_MS = 900;

export const CBM_INJECTION_QUESTIONS = {
  action: choice(
    {
      question: 'An agent just searched the code for a symbol. The code graph found locations for that symbol that the search output did not show. Which list, if any, should be shown to the agent next to its search result?',
      rule: 'Use only the facts given. Follow the definitions; when a fact and a definition conflict, the definition wins.',
    },
    {
      inject_callers: 'Show the direct callers and the definition the search missed. Fits when the agent is locating usages or a definition and the misses are a meaningful share of what it saw, or include the definition itself. Not for a symbol the agent is about to change, where callers of callers matter more.',
      inject_impact: 'Show the transitive blast radius (callers of callers). Fits when the agent is likely about to change this symbol: a missed location is inside the task\'s declared scope or in a file already edited this session, and the task changes code. Not for read-only exploration or research tasks.',
      skip: 'Show nothing. Fits when the misses are unlikely to matter: a generic or widely used symbol, a broad search that already returned many hits across many files, or misses that are a tiny share of what the search showed. Not when the definition itself was missed or the misses are the only callers.',
    },
  ),
};

export const CBM_INJECTION_DECISION = defineDecision({
  id: 'buildd.cbm_search_injection',
  promptVersion: CBM_INJECTION_PROMPT_VERSION,
  questions: CBM_INJECTION_QUESTIONS,
  mode: 'gated',
  minConfidence: CBM_INJECTION_MIN_CONFIDENCE,
  timeoutMs: CBM_INJECTION_DECISION_TIMEOUT_MS,
});

/** The record the model reads. Facts only, grouped so the definitions' words map onto keys. */
export function buildCbmInjectionState(f: CbmInjectionFacts): Record<string, unknown> {
  return {
    task: { kind: f.taskKind ?? 'unknown', category: f.taskCategory ?? 'unknown' },
    search: { tool: f.trigger === 'grep' ? 'grep_tool' : 'shell_search', hits: f.hitCount, filesWithHits: f.hitFiles },
    graph: { symbolKind: f.symbolKind ?? 'unknown', definitions: f.definitionCount, directCallers: f.callerCount },
    missed: {
      locations: f.diffSize,
      shareOfGraph: f.definitionCount + f.callerCount > 0
        ? Math.round((f.diffSize / (f.definitionCount + f.callerCount)) * 100) / 100
        : 0,
      includesDefinition: f.definitionMissed,
      insideDeclaredScope: f.missedInManifest,
      inFileAlreadyEdited: f.missedAlreadyEdited,
    },
  };
}

/**
 * Turn a run into the reply the runner acts on. Below the gate the action is
 * `inject_callers` (the live fallback); the model's own pick is still
 * reported as `label` so a later eval can score it.
 */
export function toCbmInjectionReply(run: DecisionRun<typeof CBM_INJECTION_QUESTIONS>, latencyMs: number): CbmInjectionDecisionReply {
  const outcome = run.outcomes.action;
  if (!run.ok || !outcome || outcome.status === 'skipped') {
    const kind = !run.result.ok ? run.result.error.kind : 'no_answer';
    return { ok: false, error: kind, latencyMs, version: run.version };
  }
  const label = outcome.value as CbmInjectionAction;
  if (outcome.status === 'applied') {
    return { ok: true, action: label, status: 'applied', label, confidence: outcome.confidence, latencyMs, version: run.version };
  }
  return { ok: true, action: 'inject_callers', status: 'below_threshold', label, confidence: outcome.confidence, latencyMs, version: run.version };
}
