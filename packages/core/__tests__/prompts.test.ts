import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { choice, defineDecision, defineDecisionKind, expectDecisionPinned, noul } from '@builddai/ai-kit/decide';
import {
  installPrompts,
  promptFallbackCounts,
  resetPrompts,
  resolvePrompt,
  resolvePromptEntry,
  resolvedPromptVersion,
  type ActivePrompt,
} from '../prompts';
import { loadPrompts, parsePromptRows, promptContentHash, resetPromptsLoader } from '../prompts-source';
import { definePromptedDecision, promptQuestionsMismatch } from '../prompted-decision';
import { QUESTION_GATE_DECISION, QUESTION_GATE_QUESTIONS } from '../question-gate-decision';
import { postSessionTriageKind, POST_SESSION_TRIAGE_CONFIG } from '../decision-kind-post-session-triage';
import { buildPickDecision, manifestPromptVersion, MANIFEST_DECISION_ID, MANIFEST_PROMPT_VERSION } from '../manifest-prediction';

const row = (id: string, version: number, body: string): ActivePrompt => ({ id, version, body, contentHash: promptContentHash(body) });

let warn: ReturnType<typeof spyOn>;
let info: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetPrompts();
  resetPromptsLoader();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
  info = spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  resetPrompts();
  resetPromptsLoader();
  warn.mockRestore();
  info.mockRestore();
});

describe('resolvePrompt', () => {
  it('returns the public default when no row is installed, and counts the fallback', () => {
    expect(resolvePrompt('test.greeting', 'public text')).toBe('public text');
    expect(resolvePrompt('test.greeting', 'public text')).toBe('public text');
    expect(promptFallbackCounts()['test.greeting']).toEqual({ missing: 2, invalid: 0 });
  });

  it('returns the active body when a row is installed', () => {
    installPrompts([row('test.greeting', 1, 'override text')]);
    expect(resolvePromptEntry('test.greeting', 'public text')).toEqual({ body: 'override text', source: 'active', version: 1 });
    expect(promptFallbackCounts()['test.greeting']).toBeUndefined();
  });

  it('follows a version switch', () => {
    installPrompts([row('test.greeting', 1, 'first')]);
    expect(resolvePrompt('test.greeting', 'public text')).toBe('first');
    installPrompts([row('test.greeting', 2, 'second')]);
    expect(resolvePrompt('test.greeting', 'public text')).toBe('second');
    installPrompts([]);
    expect(resolvePrompt('test.greeting', 'public text')).toBe('public text');
  });

  it('names the text in effect in the prompt version', () => {
    expect(resolvedPromptVersion('v1', { source: 'default', version: null })).toBe('v1');
    expect(resolvedPromptVersion('v1', { source: 'active', version: 4 })).toBe('v1+p4');
  });
});

describe('prompts loader', () => {
  it('a missing table (read throws) never fails and leaves the defaults', async () => {
    const snap = await loadPrompts({ force: true, read: async () => { throw new Error('relation "prompts" does not exist'); } });
    expect(snap.size).toBe(0);
    expect(resolvePrompt('test.greeting', 'public text')).toBe('public text');
  });

  it('a failed read keeps the rows already installed', async () => {
    await loadPrompts({ force: true, read: async () => [row('test.greeting', 1, 'override text')] });
    await loadPrompts({ force: true, read: async () => { throw new Error('connection refused'); } });
    expect(resolvePrompt('test.greeting', 'public text')).toBe('override text');
  });

  it('no rows installs the empty snapshot', async () => {
    await loadPrompts({ force: true, read: async () => [row('test.greeting', 1, 'override text')] });
    await loadPrompts({ force: true, read: async () => null });
    expect(resolvePrompt('test.greeting', 'public text')).toBe('public text');
  });

  it('reads at most once per TTL', async () => {
    let reads = 0;
    const read = async () => { reads++; return null; };
    let t = 1_000;
    await loadPrompts({ read, now: () => t });
    t += 1_000;
    await loadPrompts({ read, now: () => t });
    expect(reads).toBe(1);
  });

  it('skips a row whose content hash does not match its body', () => {
    const snap = parsePromptRows([
      { id: 'a', version: 1, body: 'good', contentHash: promptContentHash('good') },
      { id: 'b', version: 1, body: 'tampered', contentHash: promptContentHash('original') },
      { id: 'c', version: 0, body: 'x', contentHash: promptContentHash('x') },
    ], () => {});
    expect([...snap.keys()]).toEqual(['a']);
  });
});

const QUESTIONS = {
  verdict: choice('Is the thing ready?', { yes: 'It is ready.', no: 'It is not ready.' }),
  flag: noul('Is it flagged?'),
};
const CONFIG = { id: 'test.prompted', promptVersion: 'v1', questions: QUESTIONS, mode: 'shadow' as const };

describe('definePromptedDecision', () => {
  it('with no row is exactly the public definition', () => {
    const plain = defineDecision(CONFIG);
    const prompted = definePromptedDecision(CONFIG);
    expect(prompted.fingerprint).toBe(plain.fingerprint);
    expect(prompted.version).toBe(plain.version);
    expect(prompted.questions).toEqual(QUESTIONS);
  });

  it('an active row overrides the questions, and the fingerprint and version follow the resolved text', () => {
    const prompted = definePromptedDecision(CONFIG);
    const publicFp = prompted.fingerprint;
    const override = { ...QUESTIONS, verdict: choice('Is the thing ready to ship?', { yes: 'Ready.', no: 'Not ready.' }) };
    installPrompts([row('test.prompted', 2, JSON.stringify(override))]);
    expect(prompted.questions.verdict.instructions).toBe('Is the thing ready to ship?');
    expect(prompted.fingerprint).not.toBe(publicFp);
    expect(prompted.fingerprint).toBe(defineDecision({ ...CONFIG, questions: override }).fingerprint);
    expect(prompted.promptVersion).toBe('v1+p2');
    expect(prompted.version.startsWith('v1+p2|')).toBe(true);
  });

  it('a version switch changes the fingerprint again; removing the row restores the public one', () => {
    const prompted = definePromptedDecision(CONFIG);
    const publicFp = prompted.fingerprint;
    const v2 = { ...QUESTIONS, flag: noul('Is it flagged red?') };
    const v3 = { ...QUESTIONS, flag: noul('Is it flagged amber?') };
    installPrompts([row('test.prompted', 2, JSON.stringify(v2))]);
    const fp2 = prompted.fingerprint;
    installPrompts([row('test.prompted', 3, JSON.stringify(v3))]);
    expect(prompted.fingerprint).not.toBe(fp2);
    expect(prompted.promptVersion).toBe('v1+p3');
    installPrompts([]);
    expect(prompted.fingerprint).toBe(publicFp);
    expect(prompted.promptVersion).toBe('v1');
  });

  it('rejects an override that changes the shape, runs the public text and counts it', () => {
    const prompted = definePromptedDecision(CONFIG);
    const publicFp = prompted.fingerprint;
    const relabelled = { ...QUESTIONS, verdict: choice('Ready?', { ship: 'Ship it.', hold: 'Hold it.' }) };
    installPrompts([row('test.prompted', 2, JSON.stringify(relabelled))]);
    expect(prompted.fingerprint).toBe(publicFp);
    installPrompts([row('test.prompted', 3, 'not json')]);
    expect(prompted.fingerprint).toBe(publicFp);
    expect(promptFallbackCounts()['test.prompted'].invalid).toBe(2);
  });

  it('explains a shape mismatch', () => {
    expect(promptQuestionsMismatch(QUESTIONS, { verdict: QUESTIONS.verdict })).toMatch(/question names/);
    expect(promptQuestionsMismatch(QUESTIONS, { ...QUESTIONS, flag: { ...QUESTIONS.verdict } })).toMatch(/changes type/);
    expect(promptQuestionsMismatch(QUESTIONS, QUESTIONS)).toBeNull();
  });
});

describe('server decisions resolve through the prompts table', () => {
  it('a real decision keeps its public pin with no row, and moves with an override', () => {
    const pinned = defineDecision({
      id: QUESTION_GATE_DECISION.id,
      promptVersion: QUESTION_GATE_DECISION.promptVersion,
      questions: QUESTION_GATE_QUESTIONS,
      mode: 'gated',
      minConfidence: QUESTION_GATE_DECISION.policyOf('verdict').minConfidence ?? undefined,
    });
    expectDecisionPinned(QUESTION_GATE_DECISION, { fingerprint: pinned.fingerprint });
    const override = { verdict: { ...QUESTION_GATE_QUESTIONS.verdict, instructions: 'A different instruction.' } };
    installPrompts([row(QUESTION_GATE_DECISION.id, 1, JSON.stringify(override))]);
    expect(QUESTION_GATE_DECISION.fingerprint).not.toBe(pinned.fingerprint);
    expect(QUESTION_GATE_DECISION.version).toContain('+p1|');
  });

  it('a decision kind resolves its questions and promptFingerprint', () => {
    const publicFp = defineDecisionKind(POST_SESSION_TRIAGE_CONFIG).promptFingerprint;
    expect(postSessionTriageKind.promptFingerprint).toBe(publicFp);
    const q = POST_SESSION_TRIAGE_CONFIG.questions as Record<string, { instructions: unknown }>;
    const override = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { ...v, instructions: 'Rewritten.' }]));
    installPrompts([row(POST_SESSION_TRIAGE_CONFIG.kind, 1, JSON.stringify(override))]);
    expect(postSessionTriageKind.promptFingerprint).not.toBe(publicFp);
    expect(Object.values(postSessionTriageKind.questions as Record<string, { instructions: unknown }>)[0].instructions).toBe('Rewritten.');
  });

  it('the dynamic manifest pick resolves its text and version', () => {
    const publicFp = buildPickDecision(['a.ts', 'b.ts']).decision.fingerprint;
    expect(manifestPromptVersion()).toBe(MANIFEST_PROMPT_VERSION);
    installPrompts([row(MANIFEST_DECISION_ID, 5, JSON.stringify({ instructions: 'Pick one.', done: 'None left.' }))]);
    const { decision } = buildPickDecision(['a.ts', 'b.ts']);
    expect(decision.fingerprint).not.toBe(publicFp);
    expect(decision.promptVersion).toBe(`${MANIFEST_PROMPT_VERSION}+p5`);
    expect(manifestPromptVersion()).toBe(`${MANIFEST_PROMPT_VERSION}+p5`);
  });
});

describe('production fallback log', () => {
  it('logs a fallback once per id and reason, only in production with seeded rows, and never text', async () => {
    const { productionFallbackLogger } = await import('../prompts-source');
    const { setPromptFallbackListener } = await import('../prompts');
    const lines: string[] = [];
    setPromptFallbackListener(productionFallbackLogger({ VERCEL_ENV: 'production' }, m => lines.push(m)));

    resolvePrompt('test.unseeded', 'public words');
    expect(lines).toEqual([]); // no rows installed: running on defaults by design

    installPrompts([row('test.other', 1, 'x')]);
    resolvePrompt('test.unseeded', 'public words');
    resolvePrompt('test.unseeded', 'public words');
    expect(lines).toEqual(['[prompts] "test.unseeded" resolved to its public default (missing) in production']);
    expect(lines.join(' ')).not.toContain('public words');
  });

  it('stays quiet outside production', async () => {
    const { productionFallbackLogger } = await import('../prompts-source');
    const { setPromptFallbackListener } = await import('../prompts');
    const lines: string[] = [];
    setPromptFallbackListener(productionFallbackLogger({ VERCEL_ENV: 'preview' }, m => lines.push(m)));
    installPrompts([row('test.other', 1, 'x')]);
    resolvePrompt('test.unseeded', 'public');
    expect(lines).toEqual([]);
  });
});

describe('registration helpers mirror their read path', () => {
  it('a template must keep its placeholders; a value must keep its shape', async () => {
    const { registerTemplatePrompt, registerValuePrompt, registerTextPrompt, listRegisteredPrompts } = await import('../prompts');
    registerTemplatePrompt('test.tpl', 'Hello {{name}}');
    registerValuePrompt('test.val', { a: 'x', b: ['y'] });
    registerTextPrompt('test.txt', 'plain');
    const get = (id: string) => listRegisteredPrompts().find(p => p.id === id)!;
    expect(get('test.tpl').validate('Hi {{name}}!')).toBeNull();
    expect(get('test.tpl').validate('Hi there')).toContain('missing placeholder');
    expect(get('test.val').validate('{"a":"z","b":["q","r"]}')).toBeNull();
    expect(get('test.val').validate('{"a":"z"}')).toContain('keys differ');
    expect(get('test.val').publicDefault).toBe('{\n  "a": "x",\n  "b": [\n    "y"\n  ]\n}\n');
    expect(get('test.txt').validate('  ')).toBe('empty body');
  });

  it('promptedQuestions registration applies both question checks', async () => {
    const { registerPromptedQuestions } = await import('../prompted-decision');
    const { listRegisteredPrompts } = await import('../prompts');
    registerPromptedQuestions('test.q', { pick: choice('Pick one', { a: 'A', b: 'B' }) });
    const reg = listRegisteredPrompts().find(p => p.id === 'test.q')!;
    expect(reg.validate(reg.publicDefault)).toBeNull();
    expect(reg.validate(JSON.stringify({ pick: choice('Pick', { a: 'A', c: 'C' }) }))).toContain('labels');
  });
});
