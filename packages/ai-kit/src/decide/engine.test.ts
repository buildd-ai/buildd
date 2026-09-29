/**
 * The decide engine guard. A decision's identity is its definition, its model
 * and `DECIDE_ENGINE_VERSION`, never the kit release. That is only safe if the
 * kit cannot change what a decision does without moving the engine version, so
 * this file runs the engine over fixed fixtures and pins a digest of what it
 * did, per engine version:
 *
 * - the request each endpoint sends for a definition (System One body; the
 *   chat endpoint's messages and sampling parameters);
 * - how responses become answers (validation, logprobs → probabilities,
 *   score and confidence);
 * - how answers become outcomes (modes, thresholds, noul confidence);
 * - the `/surfaces` ranker.
 *
 * If this fails, the kit changed decision behaviour. Either undo that, or bump
 * `DECIDE_ENGINE_VERSION`, add its digest below, and say so in the CHANGELOG
 * (every app re-runs its eval and re-pins). Never edit an existing digest.
 */
import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  choice,
  decide,
  DECIDE_ENGINE_VERSION,
  defineDecision,
  gateAnswer,
  noul,
  parseDecisionAnswers,
  readAnswer,
  score,
  shortHash,
  type AnswerFor,
  type DecisionMode,
  type DecisionQuestion,
} from './index';
import { answerFromProbabilities, chatMessages, chatOptions, probabilitiesFromLogprobs } from './chat-transport';
import { defineRankSurface } from '../surfaces/index';

/** One digest per engine version. Append; never edit. */
const ENGINE_DIGESTS: Record<number, string> = {
  1: '17132f7bbee5',
};

const noSleep = () => Promise.resolve();
const QUESTIONS = {
  kind: choice('Which bucket?', { actionable: 'Needs doing', informative: { note: 'FYI' }, noise: null }),
  urgency: score('How urgent?', ['Can wait', 'This week', 'Today']),
  concerning: noul('Money problem?', { true: 'Yes', false: 'No' }),
  bare: noul('Anything else?'),
};
const STATE = { from: 'bank@example.test', subject: 'Payment failed', amount: 12.5 };

const JEV_ANSWERS = {
  kind: { type: 'choice', choice: 'actionable', probabilities: { actionable: 0.7, informative: 0.2, noise: 0.1 }, confidence: 0.7 },
  urgency: { type: 'score', score: 1.6, legend: { 0: 'Can wait', 1: 'This week', 2: 'Today' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.7 },
  concerning: { type: 'noul', noul: 0.35 },
  bare: { type: 'noul', noul: 0.92 },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function systemOneRequest() {
  let seen: { url: string; body: unknown } | null = null;
  const res = await decide({
    apiKey: 'k', state: STATE, questions: QUESTIONS, sleep: noSleep,
    fetch: async (url: string, init?: RequestInit) => {
      seen = { url: new URL(url).pathname, body: JSON.parse(String(init?.body)) };
      return json({ model: 'typesafe/jev-1.13-x', answers: JEV_ANSWERS, usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  return { seen, answers: res.ok ? res.answers : res.error.kind };
}

async function chatRequests() {
  const seen: unknown[] = [];
  const tops = [
    { ' A': 0.5, '(b)': 0.2, 'C.': 0.1, 'The': 0.2 },
    { A: 0.6, B: 0.3, C: 0.1 },
    { '*A*': 0.3, ' b': 0.7 },
  ];
  let i = 0;
  const res = await decide({
    apiKey: 'k', endpoint: { kind: 'chat', baseURL: 'https://llm.example.test/v1' }, model: 'm-1', state: STATE,
    questions: { kind: QUESTIONS.kind, urgency: QUESTIONS.urgency, concerning: QUESTIONS.concerning }, sleep: noSleep,
    fetch: async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: new URL(url).pathname, body });
      const top = tops[i++ % tops.length];
      return json({
        model: 'm-1',
        choices: [{ logprobs: { content: [{ token: 'x', logprob: 0, top_logprobs: Object.entries(top).map(([token, p]) => ({ token, logprob: Math.log(p) })) }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  // Requests go out in parallel; order them by prompt so the digest is stable.
  const requests = seen.map(s => canonicalJson(s)).sort();
  return { requests, answers: res.ok ? res.answers : res.error.kind };
}

function parsing() {
  const cases: Record<string, unknown> = {
    ok: JEV_ANSWERS,
    label_outside_set: { ...JEV_ANSWERS, kind: { ...JEV_ANSWERS.kind, choice: 'other' } },
    wrong_type: { ...JEV_ANSWERS, bare: { type: 'choice' } },
    missing: { kind: JEV_ANSWERS.kind },
    noul_out_of_range: { ...JEV_ANSWERS, bare: { type: 'noul', noul: 1.2 } },
    confidence_out_of_range: { ...JEV_ANSWERS, urgency: { ...JEV_ANSWERS.urgency, confidence: 2 } },
    extra_answer_dropped: { ...JEV_ANSWERS, extra: { type: 'noul', noul: 0.1 } },
  };
  return Object.fromEntries(Object.entries(cases).map(([k, raw]) => {
    const r = parseDecisionAnswers(QUESTIONS, raw);
    return [k, r.ok ? Object.keys(r.answers).sort() : false];
  }));
}

function gating() {
  const modes: DecisionMode[] = ['shadow', 'gated', 'live'];
  const thresholds = [null, 0, 0.6, 0.7, 0.9];
  const out: unknown[] = [];
  for (const [name, q] of Object.entries(QUESTIONS) as [string, DecisionQuestion][]) {
    const a = JEV_ANSWERS[name as keyof typeof JEV_ANSWERS] as AnswerFor<DecisionQuestion>;
    out.push({ name, read: readAnswer(q, a) });
    for (const mode of modes) {
      for (const minConfidence of thresholds) {
        const o = gateAnswer(q, a, { mode, minConfidence });
        out.push([name, mode, minConfidence, o.status, 'reason' in o ? o.reason : null]);
      }
    }
  }
  // Boundaries: a noul at exactly 0.5 and 0.4 (confidence 0.6), a choice at exactly its threshold.
  const edges: [DecisionQuestion, AnswerFor<DecisionQuestion>][] = [
    [QUESTIONS.bare, { type: 'noul', noul: 0.5 }],
    [QUESTIONS.bare, { type: 'noul', noul: 0.4 }],
    [QUESTIONS.bare, { type: 'noul', noul: 0.6 }],
    [QUESTIONS.kind, { ...JEV_ANSWERS.kind, confidence: 0.6 } as AnswerFor<DecisionQuestion>],
  ];
  for (const [q, a] of edges) {
    for (const mode of modes) {
      for (const minConfidence of thresholds) {
        const o = gateAnswer(q, a, { mode, minConfidence });
        out.push([readAnswer(q, a), mode, minConfidence, o.status, 'reason' in o ? o.reason : null]);
      }
    }
  }
  return out;
}

function chatMapping() {
  return Object.values(QUESTIONS).map(q => {
    const letters = chatOptions(q).map(o => o.letter);
    const probs = probabilitiesFromLogprobs(
      { choices: [{ logprobs: { content: [{ top_logprobs: [{ token: ' A', logprob: Math.log(0.4) }, { token: 'b', logprob: Math.log(0.4) }, { token: 'Z', logprob: Math.log(0.2) }] }] } }] },
      letters,
    );
    return { options: chatOptions(q), messages: chatMessages(STATE, q), probs, answer: probs && answerFromProbabilities(q, probs) };
  });
}

async function ranking() {
  const s = defineRankSurface({
    id: 'engine.rank', promptVersion: 'v1', candidates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    question: c => `Offer ${c.id}?`, fallback: () => ['c', 'zz', 'a'], max: 3, mode: 'gated', minConfidence: 0.6,
  });
  const ans = (score: number, confidence: number) => ({ type: 'score', score, legend: {}, probabilities: {}, confidence });
  const run = await s.decision.run({
    apiKey: 'k', state: { n: 1 }, sleep: noSleep,
    fetch: async () => json({ model: 'm', answers: { a: ans(0.4, 0.9), b: ans(1.9, 0.8), c: ans(0.4, 0.7), d: ans(2, 0.2) }, usage: {} }),
  });
  // The pick's `version` is identity, not behaviour: leave it out.
  const rank = (r: Parameters<typeof s.rank>[1]) => { const { version: _v, ...pick } = s.rank({ n: 1 }, r); return pick; };
  return {
    jev: rank(run),
    fewApplied: rank({ ok: true, outcomes: { ...run.outcomes, a: { status: 'skipped', reason: 'error', error: { kind: 'timeout', timeoutMs: 1 } }, b: run.outcomes.d, c: run.outcomes.d } } as never),
    // Exactly half applied: the minAppliedShare boundary.
    halfApplied: rank({ ok: true, outcomes: { ...run.outcomes, c: run.outcomes.d } } as never),
    none: rank(null),
    failed: rank({ ok: false, outcomes: {} } as never),
  };
}

describe('decide engine', () => {
  it(`behaviour matches the pinned digest for engine ${DECIDE_ENGINE_VERSION}`, async () => {
    const behaviour = {
      systemOne: await systemOneRequest(),
      chat: await chatRequests(),
      chatMapping: chatMapping(),
      parsing: parsing(),
      gating: gating(),
      ranking: await ranking(),
      policies: (() => {
        const d = defineDecision({ id: 'engine.p', promptVersion: 'v1', questions: QUESTIONS, mode: 'shadow', modes: { kind: 'gated', bare: 'live' }, minConfidence: { kind: 0.8 } });
        return Object.keys(QUESTIONS).map(n => d.policyOf(n as keyof typeof QUESTIONS));
      })(),
    };
    const digest = shortHash(canonicalJson(behaviour));
    const pinned = ENGINE_DIGESTS[DECIDE_ENGINE_VERSION];
    if (digest !== pinned) {
      throw new Error(
        `decide engine behaviour changed (digest ${digest}, engine ${DECIDE_ENGINE_VERSION} pinned ${pinned}). ` +
        'Undo the change, or bump DECIDE_ENGINE_VERSION, add its digest to ENGINE_DIGESTS and note it in the CHANGELOG.',
      );
    }
    expect(digest).toBe(pinned);
  });

  it('the digest sees a change to any part of the behaviour', () => {
    // A sanity check of the guard itself: canonicalJson + shortHash separate close inputs.
    const a = shortHash(canonicalJson({ gating: [['kind', 'gated', 0.7, 'applied', null]] }));
    const b = shortHash(canonicalJson({ gating: [['kind', 'gated', 0.7, 'suggested', 'below_threshold']] }));
    expect(a).not.toBe(b);
  });
});
