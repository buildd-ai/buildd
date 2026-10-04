/**
 * Decisions whose question text resolves through the versioned prompts table
 * (`prompts.ts`).
 *
 * `definePromptedDecision(config)` is `defineDecision(config)` with one
 * difference: on every read it asks `activePrompt(config.id)` for an override
 * of `config.questions`, and when there is one, the decision in effect is
 * defined from the resolved questions. Its `fingerprint` is therefore computed
 * from the text actually sent, and its `promptVersion` / `version` name the
 * active row (`<public>+p<row version>`), so a ledger row says which text
 * produced it. With no active row it is exactly the public definition, so
 * pinned fingerprints of public defaults are unchanged.
 *
 * An override body is JSON: a full `DecisionQuestions` object. It must keep the
 * default's shape (same question names; same type per question; a choice keeps
 * its labels, a score its level count), because call sites act on those. A
 * body that does not fit is rejected, counted as a fallback and logged once;
 * the public definition runs.
 *
 * `promptedDecisionKind` does the same for a `defineDecisionKind` result.
 *
 * The resolved definition is cached per active row, so a resolve is a map
 * lookup and a string compare, never a DB read.
 */
import {
  defineDecision,
  defineDecisionKind,
  type Decision,
  type DecisionConfig,
  type DecisionKind,
  type DecisionKindConfig,
  type DecisionQuestion,
  type DecisionQuestions,
} from '@builddai/ai-kit/decide';
import { activePrompt, notePromptRejected, registerPrompt, resolvedPromptVersion, type ActivePrompt } from './prompts';

/** Why an override's questions do not fit the default's shape, or null when they do. */
export function promptQuestionsMismatch(publicQuestions: DecisionQuestions, candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return 'body is not a JSON object of questions';
  const cand = candidate as Record<string, unknown>;
  const want = Object.keys(publicQuestions).sort();
  const got = Object.keys(cand).sort();
  if (want.join('\n') !== got.join('\n')) return 'question names differ from the default';
  for (const name of want) {
    const p = publicQuestions[name] as DecisionQuestion;
    const c = cand[name] as Partial<DecisionQuestion> | null;
    if (!c || typeof c !== 'object' || c.type !== p.type) return `question "${name}" changes type`;
    if (p.type === 'choice') {
      const crit = (c as { criteria?: unknown }).criteria;
      if (!crit || typeof crit !== 'object' || Array.isArray(crit)) return `question "${name}" has no criteria object`;
      if (Object.keys(p.criteria).sort().join('\n') !== Object.keys(crit).sort().join('\n')) return `question "${name}" changes its labels`;
    }
    if (p.type === 'score') {
      const crit = (c as { criteria?: unknown }).criteria;
      if (!Array.isArray(crit) || crit.length !== p.criteria.length) return `question "${name}" changes its level count`;
    }
  }
  return null;
}

/**
 * Check an override body against the default's questions: parse it, compare
 * shapes, then build the definition (`define` may throw). Pure; shared by the
 * read path below and by the seed's validation (`registerPrompt`), so a seed
 * refuses exactly what a resolve would reject.
 */
export function checkQuestionsOverride<T>(
  publicQuestions: DecisionQuestions,
  body: string,
  define: (questions: DecisionQuestions) => T,
): { ok: true; value: T } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  const mismatch = promptQuestionsMismatch(publicQuestions, parsed);
  if (mismatch) return { ok: false, reason: mismatch };
  try {
    return { ok: true, value: define(parsed as DecisionQuestions) };
  } catch (err) {
    return { ok: false, reason: `definition rejected: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Register `id` as a JSON-questions prompt whose override must pass `checkQuestionsOverride`. */
function registerQuestionsPrompt(id: string, publicQuestions: DecisionQuestions, define: (questions: DecisionQuestions) => unknown): void {
  registerPrompt({
    id,
    format: 'json',
    publicDefault: `${JSON.stringify(publicQuestions, null, 2)}\n`,
    validate: body => {
      const checked = checkQuestionsOverride(publicQuestions, body, define);
      return checked.ok ? null : checked.reason;
    },
  });
}

/**
 * The override's questions for `id`, or null (no active row, or a rejected
 * one). `define` builds the definition from them and may throw; a throw is a
 * rejection too.
 */
function resolveOverride<T>(
  id: string,
  publicQuestions: DecisionQuestions,
  cache: { key: string | null; value: T | null },
  define: (questions: DecisionQuestions, row: ActivePrompt) => T,
): T | null {
  const row = activePrompt(id);
  if (!row) return null;
  const key = `${row.version}:${row.contentHash}`;
  if (cache.key === key) return cache.value;
  const checked = checkQuestionsOverride(publicQuestions, row.body, questions => define(questions, row));
  if (!checked.ok) notePromptRejected(row, checked.reason);
  const value = checked.ok ? checked.value : null;
  cache.key = key;
  cache.value = value;
  return value;
}

/** `defineDecision`, with its questions resolved through the prompts table on every read. */
export function definePromptedDecision<const Q extends DecisionQuestions>(config: DecisionConfig<Q>): Decision<Q> {
  const base = defineDecision(config);
  registerQuestionsPrompt(config.id, config.questions, questions => defineDecision({ ...config, questions: questions as Q }));
  const cache: { key: string | null; value: Decision<Q> | null } = { key: null, value: null };
  const current = (): Decision<Q> =>
    resolveOverride(config.id, config.questions, cache, (questions, row) => {
      const resolved: DecisionConfig<Q> = {
        ...config,
        questions: questions as Q,
        promptVersion: resolvedPromptVersion(config.promptVersion, { source: 'active', version: row.version }),
      };
      return defineDecision(resolved);
    }) ?? base;

  return Object.freeze({
    id: base.id,
    get promptVersion() { return current().promptVersion; },
    get model() { return current().model; },
    get version() { return current().version; },
    get fingerprint() { return current().fingerprint; },
    get engine() { return current().engine; },
    get kitVersion() { return current().kitVersion; },
    get questions() { return current().questions; },
    policyOf: (name: keyof Q & string) => current().policyOf(name),
    run: (opts: Parameters<Decision<Q>['run']>[0]) => current().run(opts),
    runEach: <T>(items: readonly T[], opts: Parameters<Decision<Q>['runEach']>[1]) =>
      current().runEach(items, opts as never),
  }) as Decision<Q>;
}

/**
 * Resolve a defined kind's questions through the prompts table on every read.
 * `questions` and `promptFingerprint` follow the active row; everything else
 * is the kind as defined. `extra` is spread onto the result (a binding, say).
 */
export function promptedDecisionKind<K extends string, F, D extends string, Q extends DecisionQuestions, X extends object>(
  config: DecisionKindConfig<K, F, D, Q>,
  extra: X,
): DecisionKind<K, F, D, Q> & X {
  const base = defineDecisionKind(config);
  registerQuestionsPrompt(config.kind, config.questions, questions => defineDecisionKind({ ...config, questions: questions as Q }));
  const cache: { key: string | null; value: DecisionKind<K, F, D, Q> | null } = { key: null, value: null };
  const current = (): DecisionKind<K, F, D, Q> =>
    resolveOverride(config.kind, config.questions, cache, questions => {
      const resolved: DecisionKindConfig<K, F, D, Q> = { ...config, questions: questions as Q };
      return defineDecisionKind(resolved);
    }) ?? base;

  const out = { ...base, ...extra } as DecisionKind<K, F, D, Q> & X;
  Object.defineProperties(out, {
    questions: { get: () => current().questions, enumerable: true },
    promptFingerprint: { get: () => current().promptFingerprint, enumerable: true },
  });
  return Object.freeze(out);
}
