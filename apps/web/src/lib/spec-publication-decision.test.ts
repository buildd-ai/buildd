import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const {
  parsePublicationFeatures, publicationOverride, publicationState, interpretPublication, decidePublication, lineOfReason,
  specPublicationKind, PUBLICATION_PUBLISH_P, MAX_PUBLICATION_TEXT_CHARS, SPEC_PUBLICATION_CONFIG,
} = await import('./spec-publication-decision');
const { parsePublicationSection, publicationReason } = await import('./specs/publication');
const { runDecisionKind } = await import('@builddai/ai-kit/decide');

const POLICY_BODY = `# Shop

The product.

## Publication

The repo is public. When in doubt, it stays in buildd.

May be published:

- How a feature behaves for the people who use it.
- Formats other tools depend on.

Stays in buildd:

- Operator-only tooling and how the platform is run day to day.
- Security weaknesses until the fix has shipped.

## Something else

- not a policy line
`;

const section = parsePublicationSection(POLICY_BODY)!;
const POLICY = { version: 'abcd1234-r2', text: section.text, lines: section.lines };
const TEXT = '# Widget exports\n\n- AC-1: GIVEN a widget WHEN exported THEN one file is written.\n';
const dest = (priv: boolean | null = false) => ({ kind: 'repo_spec_copy', label: 'the repo, which is public, as docs/specs/x.md', private: priv });
const features = (over: Record<string, unknown> = {}) => ({ text: TEXT, destination: dest(), policy: POLICY, mark: null, ...over });
const parsed = (over: Record<string, unknown> = {}) => {
  const p = parsePublicationFeatures(features(over));
  if (!p.ok) throw new Error(p.message);
  return p.features;
};

describe('the policy section (D-21)', () => {
  it('reads the Publication section only, numbering each line under its label', () => {
    expect(section.lines).toEqual([
      { n: 1, group: 'publish', text: 'How a feature behaves for the people who use it.' },
      { n: 2, group: 'publish', text: 'Formats other tools depend on.' },
      { n: 3, group: 'private', text: 'Operator-only tooling and how the platform is run day to day.' },
      { n: 4, group: 'private', text: 'Security weaknesses until the fix has shipped.' },
    ]);
    expect(section.text).not.toContain('not a policy line');
    expect(parsePublicationSection('# Shop\n\nNo policy here.\n')).toBeNull();
  });
});

describe('the fixed rules, in order (R-67)', () => {
  it('a production-data hit keeps it private before anything else, even a public mark (AC-50)', () => {
    const f = parsed({ text: `${TEXT}\nSpec 1a2b3c4d-0000-4000-8000-00000000abcd was first.\n`, mark: 'public', destination: dest(true) });
    expect(f.prodDataHits.length).toBeGreaterThan(0);
    expect(publicationOverride(f)).toEqual({ decision: 'keep_private', reasonCode: 'rule_prod_data' });
  });
  it('a caller cannot assert the scan: it is derived from the text', () => {
    const p = parsePublicationFeatures({ ...features(), prodDataHits: [] , text: 'id 1a2b3c4d-0000-4000-8000-00000000abcd' });
    expect(p.ok && p.features.prodDataHits.length).toBe(1);
  });
  it('no approved policy keeps it private (D-21, AC-49), whatever the mark or the repo', () => {
    expect(publicationOverride(parsed({ policy: null, mark: 'public', destination: dest(true) }))).toEqual({ decision: 'keep_private', reasonCode: 'rule_no_policy' });
  });
  it('a private mark keeps it private and a public mark publishes, before the repo and the model', () => {
    expect(publicationOverride(parsed({ mark: 'private', destination: dest(true) }))).toEqual({ decision: 'keep_private', reasonCode: 'rule_marked_private' });
    expect(publicationOverride(parsed({ mark: 'public' }))).toEqual({ decision: 'publish', reasonCode: 'rule_marked_public' });
  });
  it('a private repo publishes; an unknown or public one asks the model', () => {
    expect(publicationOverride(parsed({ destination: dest(true) }))).toEqual({ decision: 'publish', reasonCode: 'rule_private_destination' });
    expect(publicationOverride(parsed({ destination: dest(null) }))).toBeNull();
    expect(publicationOverride(parsed())).toBeNull();
  });
  it('a text too long to read whole stays private', () => {
    expect(publicationOverride(parsed({ text: 'x'.repeat(MAX_PUBLICATION_TEXT_CHARS + 1) }))).toEqual({ decision: 'keep_private', reasonCode: 'rule_too_long' });
  });
});

describe('the kind (D-22)', () => {
  it('is live under its own capability, answers within its set, and falls back to private for every cause', () => {
    expect(specPublicationKind.binding).toMatchObject({ capability: 'spec_publication', mode: 'live' });
    expect(specPublicationKind.decisions).toEqual(['publish', 'keep_private', 'unsure']);
    for (const cause of ['disabled', 'invalid_features', 'no_provider', 'provider_failure', 'low_confidence', 'unmeasured_model', 'shadow'] as const) {
      expect(SPEC_PUBLICATION_CONFIG.fallback(null, cause).decision).toBe('keep_private');
    }
  });
  it('the bar starts unmeasured (R-69)', () => {
    expect(PUBLICATION_PUBLISH_P).toBeNull();
    expect(SPEC_PUBLICATION_CONFIG.minConfidence).toBe(1);
  });
  it('the state numbers the policy lines and carries where the text goes and the text', () => {
    const s = publicationState(parsed());
    expect(s).toContain('[3] (stays private) Operator-only tooling');
    expect(s).toContain('[1] (may be published) How a feature behaves');
    expect(s).toContain('Where the text is going: the repo, which is public');
    expect(s).toContain('AC-1: GIVEN a widget');
  });
  it('reads the answer and the quoted line; a line past the list is none', () => {
    const f = parsed();
    expect(interpretPublication({ publication: { choice: 'keep_private', probabilities: { keep_private: 0.8 } }, line: { choice: 'line_3' } }, f))
      .toEqual({ decision: 'keep_private', confidence: 0.8, reasonCode: 'model_keep_private_line_3' });
    expect(interpretPublication({ publication: { choice: 'publish', probabilities: { publish: 0.6 } }, line: { choice: 'line_9' } }, f).reasonCode).toBe('model_publish_line_none');
    expect(lineOfReason('model_keep_private_line_3', POLICY)?.text).toBe('Operator-only tooling and how the platform is run day to day.');
  });
  it('a private mark is never overruled, whatever the model would answer (AC-50)', async () => {
    const r = await runDecisionKind(specPublicationKind, { features: features({ mark: 'private' }) }, { mode: 'live', cheap: { provider: 'x', model: 'm', invoke: async () => { throw new Error('the model must not be asked'); } } as any });
    expect(r).toMatchObject({ decision: 'keep_private', source: 'rule', reasonCode: 'rule_marked_private' });
  });
});

const respond = (r: Record<string, unknown>) => ({ judge: async () => ({ response: { attempts: [], confidence: null, model: null, fallbackCause: null, ...r } as any, recordId: 'rec-1' }), teamOf: async () => 'team' });
const input = (over: Record<string, unknown> = {}) => ({ workspaceId: 'w', subjectId: 's', text: TEXT, destination: dest(), policy: POLICY, mark: null, ...over }) as any;

describe('decidePublication', () => {
  it('a rule answer is applied as-is and carries its sentence', async () => {
    const out = await decidePublication(input({ policy: null }), respond({ decision: 'keep_private', source: 'rule', reasonCode: 'rule_no_policy' }));
    expect(out).toMatchObject({ publish: false, source: 'rule', reasonCode: 'rule_no_policy', decisionRecordId: 'rec-1' });
    expect(out.reason).toContain('no publication policy yet');
  });
  it('AC-51: no model available keeps it private, recorded as a fallback', async () => {
    const out = await decidePublication(input(), respond({ decision: 'keep_private', source: 'fallback', fallbackCause: 'no_provider', reasonCode: 'fallback_no_provider' }));
    expect(out).toMatchObject({ publish: false, source: 'fallback', reasonCode: 'fallback_no_provider' });
    expect(out.reason).toContain('no decision model');
  });
  it('AC-51: an answer below the bar keeps it private as a fallback, with the line the model named', async () => {
    const out = await decidePublication(input(), respond({
      decision: 'keep_private', source: 'fallback', fallbackCause: 'low_confidence', reasonCode: 'fallback_low_confidence',
      attempts: [{ decision: 'publish', confidence: 0.97, reasonCode: 'model_publish_line_1', model: 'typesafe/jev-1' }],
    }));
    expect(out).toMatchObject({ publish: false, source: 'fallback', reasonCode: 'below_bar', confidence: 0.97, line: 'How a feature behaves for the people who use it.' });
  });
  it('even a model publish at full confidence stays private while the bar is unmeasured', async () => {
    const out = await decidePublication(input(), respond({ decision: 'publish', source: 'model', confidence: 1, reasonCode: 'model_publish_line_1' }));
    expect(out).toMatchObject({ publish: false, reasonCode: 'below_bar' });
  });
  it('with a measured bar, a publish at it publishes; one naming a private line does not', async () => {
    const ok = await decidePublication(input(), { ...respond({ decision: 'publish', source: 'model', confidence: 0.99, reasonCode: 'model_publish_line_1' }), bar: 0.95 });
    expect(ok).toMatchObject({ publish: true, source: 'model', line: 'How a feature behaves for the people who use it.' });
    const bad = await decidePublication(input(), { ...respond({ decision: 'publish', source: 'model', confidence: 0.99, reasonCode: 'model_publish_line_3' }), bar: 0.95 });
    expect(bad.publish).toBe(false);
  });
  it('a model keep_private names the policy line in the sentence (R-68)', async () => {
    const out = await decidePublication(input(), respond({ decision: 'keep_private', source: 'model', confidence: 1, reasonCode: 'model_keep_private_line_3' }));
    expect(out.reason).toBe('Not published: the policy keeps this out of the repo ("Operator-only tooling and how the platform is run day to day.").');
  });
  it('a throw keeps it private', async () => {
    const out = await decidePublication(input(), { judge: async () => { throw new Error('boom'); }, teamOf: async () => 'team' });
    expect(out).toMatchObject({ publish: false, reasonCode: 'fallback_error' });
  });
});

describe('the sentences (R-68)', () => {
  it('say why in one sentence, without status labels', () => {
    for (const code of ['rule_prod_data', 'rule_no_policy', 'rule_marked_private', 'rule_too_long', 'model_keep_private_line_none', 'model_unsure_line_none', 'below_bar', 'fallback_no_provider']) {
      const s = publicationReason({ publish: false, reasonCode: code });
      expect(s.startsWith('Not published: ')).toBe(true);
      expect(s).not.toMatch(/—/);
    }
    expect(publicationReason({ publish: false, reasonCode: 'rule_marked_private', markFrom: 'area' })).toBe('Not published: its area is marked private.');
  });
});
