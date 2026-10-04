/**
 * The decision model's suggestion for an agent endpoint model row nothing
 * deterministic matched (docs/design/agent-model-endpoint.md §4): buildd asks
 * for model X, the endpoint does not serve it under any name buildd can
 * recognise, so which of the endpoint's own models is closest?
 *
 * Last resort and suggestion only. The settings editor fills rows from the
 * saved alias, the id as is, the tier registry and same-model names first;
 * only what is still unmatched comes here, and an answer is shown flagged
 * ("suggested", with its confidence) for the person to keep or change. Nothing
 * here stores a mapping.
 *
 * The label set is the endpoint's ids (a lexical prefilter caps it), and the
 * state is model ids only. Fails soft: no decision model, a disabled
 * capability, a timeout, a low-confidence pick or a throw all mean "no
 * suggestion" for that row.
 */
import { resolvedPromptVersion, resolvePromptValue, resolvePromptValueEntry } from '@buildd/core/prompts';
import { suggestionCandidates, MAX_LISTED_MODELS } from '@buildd/core/agent-endpoint-models';
import type {
  ChoiceQuestion,
  DecisionAccess,
  DecisionReceipt,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';

export const ENDPOINT_MODEL_SUGGEST_CAPABILITY = 'endpoint_model_match' as const;
export const ENDPOINT_MODEL_SUGGEST_DECISION_ID = 'endpoint_model_match';
export const ENDPOINT_MODEL_SUGGEST_LOG_PREFIX = '[endpoint-model-suggest]';
/** Bump when the question or the state shape changes. */
export const ENDPOINT_MODEL_SUGGEST_PROMPT_VERSION = 'em1';
/** Provisional, not from an eval: a shown suggestion still needs the person's save. */
export const SUGGEST_MIN_CONFIDENCE = 0.6;
export const SUGGEST_TIMEOUT_MS = 4_000;
/** Rows asked about per request, and candidates per row. */
export const MAX_SUGGEST_MODELS = 8;
export const MAX_SUGGEST_CANDIDATES = 20;

const MODEL_ID_RE = /^[\x21-\x7e]{1,200}$/;

export interface EndpointModelSuggestion {
  /** The native id buildd asks for. */
  model: string;
  /** One of the endpoint's listed ids. */
  suggested: string;
  confidence: number;
}

type Questions = { pick: ChoiceQuestion<string> };
type DecideFn = typeof decisionCall<Questions>;
type ResolveAccess = (opts: {
  capability: typeof ENDPOINT_MODEL_SUGGEST_CAPABILITY;
  teamId: string;
  workspaceId: string | null;
  accountId: string | null;
  userId: string | null;
}) => Promise<DecisionAccess>;

export interface SuggestDeps {
  decide?: DecideFn;
  resolveAccess?: ResolveAccess;
  recordReceipt?: (receipt: DecisionReceipt, scope: { teamId: string; accountId: string | null }) => Promise<void>;
  log?: (line: string) => void;
}

export function suggestQuestion(model: string, candidates: readonly string[]): ChoiceQuestion<string> {
  return {
    type: 'choice',
    instructions: { ...resolvePromptValue(ENDPOINT_MODEL_SUGGEST_PROMPT_ID, ENDPOINT_MODEL_SUGGEST_INSTRUCTIONS) },
    criteria: Object.fromEntries(candidates.map((c) => [c, null])),
  };
}

/** The prompts-table id whose active row (JSON `{ question, rule }`) may replace the instructions below. */
export const ENDPOINT_MODEL_SUGGEST_PROMPT_ID = 'buildd.endpoint_model_suggest';

export const ENDPOINT_MODEL_SUGGEST_INSTRUCTIONS = {
  question: `An agent will ask a model proxy for \`asks_for\`, which the proxy does not serve under that name. Which model the proxy does serve is the closest replacement?`,
  rule: 'Prefer the same vendor and model family, then the nearest capability and price. Judge from the model ids only.',
};

/**
 * One suggestion per model where the decision model is confident. Never
 * throws; an empty list means "no suggestions". Logs ids, labels and numbers.
 */
export async function suggestEndpointModels(
  input: { teamId: string; workspaceId: string | null; accountId?: string | null; userId?: string | null; listed: readonly unknown[]; models: readonly unknown[] },
  deps: SuggestDeps = {},
): Promise<EndpointModelSuggestion[]> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    const clean = (xs: readonly unknown[], max: number) =>
      [...new Set(xs.filter((x): x is string => typeof x === 'string' && MODEL_ID_RE.test(x)))].slice(0, max);
    const listed = clean(input.listed, MAX_LISTED_MODELS);
    const models = clean(input.models, MAX_SUGGEST_MODELS).filter((m) => !listed.includes(m));
    const asks = models
      .map((model) => ({ model, candidates: suggestionCandidates(model, listed, MAX_SUGGEST_CANDIDATES) }))
      .filter((a) => a.candidates.length >= 2);
    if (asks.length === 0) return [];

    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const access = await resolveAccess({
      capability: ENDPOINT_MODEL_SUGGEST_CAPABILITY,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
    });
    if (!access.ok) return [];

    const scope = { teamId: input.teamId, accountId: input.accountId ?? null };
    const recordReceipt = deps.recordReceipt ?? (async (receipt, s) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts([receipt], s);
    });
    const decide = deps.decide ?? (client!.decisionCall as DecideFn);

    const results = await Promise.all(asks.map(async ({ model, candidates }) => {
      try {
        const receipts: Promise<void>[] = [];
        const res: DecisionResult<Questions> = await decide({
          capability: ENDPOINT_MODEL_SUGGEST_CAPABILITY,
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          accountId: input.accountId ?? null,
          userId: input.userId ?? null,
          state: { asks_for: model, proxy_serves: candidates },
          questions: { pick: suggestQuestion(model, candidates) },
          timeoutMs: SUGGEST_TIMEOUT_MS,
          decisionId: ENDPOINT_MODEL_SUGGEST_DECISION_ID,
          access,
          onUsage: (receipt) => { receipts.push(recordReceipt(receipt, scope).catch(() => {})); },
        });
        await Promise.all(receipts);
        if (!res.ok) {
          log(`${ENDPOINT_MODEL_SUGGEST_LOG_PREFIX} ${JSON.stringify({ model, error: res.error.kind, latencyMs: res.latencyMs })}`);
          return null;
        }
        const { choice, confidence } = res.answers.pick;
        const shown = confidence >= SUGGEST_MIN_CONFIDENCE && candidates.includes(choice);
        log(`${ENDPOINT_MODEL_SUGGEST_LOG_PREFIX} ${JSON.stringify({
          v: `${resolvedPromptVersion(ENDPOINT_MODEL_SUGGEST_PROMPT_VERSION, resolvePromptValueEntry(ENDPOINT_MODEL_SUGGEST_PROMPT_ID, ENDPOINT_MODEL_SUGGEST_INSTRUCTIONS))}|${res.model}`,
          model, pick: choice, confidence, candidates: candidates.length, shown, latencyMs: res.latencyMs,
        })}`);
        return shown ? { model, suggested: choice, confidence } : null;
      } catch (err) {
        console.error(`${ENDPOINT_MODEL_SUGGEST_LOG_PREFIX} failed (non-fatal, row stays unmapped):`, err);
        return null;
      }
    }));
    return results.filter((r): r is EndpointModelSuggestion => r !== null);
  } catch (err) {
    console.error(`${ENDPOINT_MODEL_SUGGEST_LOG_PREFIX} failed (non-fatal, rows stay unmapped):`, err);
    return [];
  }
}
