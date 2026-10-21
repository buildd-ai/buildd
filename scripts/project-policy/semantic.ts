import { createHash } from 'node:crypto';
import { choice, defineDecision, canonicalJson, JEV_MODEL, redactSecrets, type DecideParams, type DecisionReceipt, type DecisionEndpoint, type ClefModel } from '../../packages/ai-kit/src/decide';
import type { ChangedSubject, ProjectPolicy, SubjectContext } from './pipeline';
import { findTerm } from '../../packages/shared/src/terms';

export type SemanticLabel = 'useful' | 'redundant' | 'unclear' | 'uncertain';
export interface SemanticEvaluation {
  label: SemanticLabel | 'unsupported'; reasonCode: string;
  model: string; version: string; promptFingerprint: string; inputFingerprint: string;
  confidence: number | null; latencyMs: number; costUsd: number | null; attempts: number;
  receipt: DecisionReceipt | null;
  /** Chosen-label probability, separate from the model's raw confidence. Neither is calibrated here. */
  topProbability?: number;
  coalesced?: true;
  cache?: { hit: true; recordedAt: number; historical: { attempts: number; latencyMs: number; costUsd: number | null } };
}
export type SemanticEvaluator = (subject: ChangedSubject, policy: ProjectPolicy, context?: SubjectContext) => Promise<SemanticEvaluation>;

/** No path, source, diff, old string, arbitrary context or repository contents. */
export function buildSemanticState(subject: ChangedSubject, context?: SubjectContext) {
  const term = context?.state ? findTerm(context.state) : undefined;
  const canonicalLabel = term?.word;
  const scheduledAt = term?.key === 'wait.scheduled' && context?.scheduledAt && Number.isFinite(Date.parse(context.scheduledAt))
    ? new Date(context.scheduledAt).toISOString() : undefined;
  const nearby = context?.staticContext ?? subject.staticContext;
  const staticContext = nearby ? { container: nearby.container, heading: nearby.heading,
    nearbyText: nearby.nearbyText, completeness: nearby.completeness } : undefined;
  return { text: subject.after, role: context?.role ?? subject.role,
    component: subject.component, prop: subject.prop, purpose: context?.purpose ?? 'unknown',
    ...(canonicalLabel ? { canonicalLabel } : {}), ...(scheduledAt ? { scheduledAt } : {}),
    ...(context?.action === 'approval' ? { action: 'approval' } : {}), ...(staticContext ? { staticContext } : {}) };
}

type ClefRoute = { model: ClefModel; endpoint: DecisionEndpoint & { kind: 'workers-ai' } };
export function semanticDecision(policy: ProjectPolicy, route?: ClefRoute) {
  const labels = ['useful', 'redundant', 'unclear', 'uncertain'] as const;
  if (Object.keys(policy.semantic.labels).sort().join(',') !== [...labels].sort().join(',')) throw new Error('Semantic labels must retain the fixed typed contract.');
  const criteria = Object.fromEntries(labels.map(label => [label, policy.semantic.labels[label]])) as Record<SemanticLabel, string>;
  return defineDecision({ id: `${policy.id}.semantic-value`, promptVersion: `policy-${policy.version}`,
    mode: 'shadow', model: route?.model ?? JEV_MODEL, ...(route ? { endpoint: route.endpoint } : {}),
    questions: { value: choice(`${policy.semantic.instructions} Static context is partial syntax, not proof of runtime visibility or state. Do not infer missing surrounding facts.`, criteria) } });
}

/** Explicit local exploration uses the existing typed shadow engine/transport and receipts. */
export function createJevEvaluator(apiKey?: string | null, fetcher?: DecideParams<ReturnType<typeof semanticDecision>['questions']>['fetch'], budget = 20): SemanticEvaluator {
  return createSemanticEvaluator(apiKey, fetcher, budget);
}

export function createClefEvaluator(model: ClefModel, apiKey: string | null | undefined, endpoint: ClefRoute['endpoint'],
  fetcher?: DecideParams<ReturnType<typeof semanticDecision>['questions']>['fetch'], budget = 20): SemanticEvaluator {
  return createSemanticEvaluator(apiKey, fetcher, budget, { model, endpoint });
}

function createSemanticEvaluator(apiKey?: string | null, fetcher?: DecideParams<ReturnType<typeof semanticDecision>['questions']>['fetch'], budget = 20, route?: ClefRoute): SemanticEvaluator {
  let calls = 0;
  const maxCalls = Number.isInteger(budget) ? Math.max(0, Math.min(5000, budget)) : 0;
  return async (subject, policy, context) => {
    const definition = semanticDecision(policy, route);
    const state = buildSemanticState(subject, context);
    const inputFingerprint = createHash('sha256').update(canonicalJson({ state, policy: `${policy.id}@${policy.version}`,
      policyAuthority: policy.authority.hash, prompt: definition.fingerprint })).digest('hex');
    const base = { model: definition.model, version: definition.version, promptFingerprint: definition.fingerprint,
      inputFingerprint, confidence: null, latencyMs: 0, costUsd: null, attempts: 0, receipt: null };
    const unsupported = (reasonCode: string): SemanticEvaluation => ({ ...base, label: 'unsupported', reasonCode });
    if (!apiKey) return unsupported('missing_key');
    if (state.text === null || state.role === 'unknown') return unsupported('unresolved_copy');
    if (state.text.length > 500 || state.component.length > 80 || state.prop.length > 80 || state.purpose.length > 80) return unsupported('context_too_large');
    if (state.staticContext && (state.staticContext.completeness !== 'static-partial'
      || typeof state.staticContext.container !== 'string' || state.staticContext.container.length > 80
      || state.staticContext.heading !== undefined && (typeof state.staticContext.heading !== 'string' || state.staticContext.heading.length > 120)
      || !Array.isArray(state.staticContext.nearbyText) || state.staticContext.nearbyText.length > 2
      || state.staticContext.nearbyText.some(text => typeof text !== 'string' || text.length > 160))) return unsupported('context_too_large');
    const outbound = canonicalJson(state);
    if (redactSecrets(outbound, [apiKey]) !== outbound
      || /(?:sk-|bld_|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(outbound)) return unsupported('sensitive_copy');
    if (calls >= maxCalls) return unsupported('local_budget_exhausted');
    calls++;
    const run = await definition.run({ apiKey, state, ...(fetcher ? { fetch: fetcher } : {}), timeoutMs: 5000, maxAttempts: 2 });
    if (!run.result.ok) return { ...unsupported(run.result.error.kind), latencyMs: run.result.latencyMs,
      attempts: run.result.attempts, receipt: run.receipt };
    const answer = run.result.answers.value;
    return { ...base, label: answer.choice, reasonCode: `model_${answer.choice}`, confidence: answer.confidence,
      topProbability: answer.probabilities[answer.choice],
      model: run.result.model, latencyMs: run.result.latencyMs, costUsd: run.result.usage.costUsd,
      attempts: run.result.attempts, receipt: run.receipt };
  };
}
