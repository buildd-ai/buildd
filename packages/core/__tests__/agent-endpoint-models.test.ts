/**
 * Model discovery for the agent model endpoint
 * (docs/design/agent-model-endpoint.md §4): picking the Verify probe model from
 * the endpoint's own `/v1/models` list, and the derived aliases that let a
 * dated tier id reach a proxy that only serves the undated name. Pure, except
 * listAgentEndpointModels (fake fetcher). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  MAX_LISTED_MODELS,
  buildEndpointModelRows,
  matchListedModel,
  suggestionCandidates,
  canonicalModelId,
  claudeFamily,
  deriveModelAliases,
  findListedEquivalent,
  listAgentEndpointModels,
  parseModelList,
  selectProbeModel,
  usableListedModels,
} from '../agent-endpoint-models';

const DATED = 'claude-haiku-4-5-20251001';

describe('canonicalModelId / findListedEquivalent (rule c)', () => {
  it('a dated id and its undated form are the same model', () => {
    expect(canonicalModelId(DATED)).toBe(canonicalModelId('claude-haiku-4-5'));
    expect(findListedEquivalent(DATED, ['claude-sonnet-5', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5');
    // And the other way round.
    expect(findListedEquivalent('claude-haiku-4-5', [DATED])).toBe(DATED);
  });

  it('tolerates a provider/ prefix, preferring the unprefixed name', () => {
    expect(findListedEquivalent(DATED, ['anthropic/claude-haiku-4-5'])).toBe('anthropic/claude-haiku-4-5');
    expect(findListedEquivalent(DATED, ['anthropic/claude-haiku-4-5', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5');
  });

  it('never matches another family or another version', () => {
    expect(findListedEquivalent(DATED, ['claude-sonnet-4-5', 'claude-haiku-4', 'claude-haiku-4-6', 'claude-haiku-4-5-turbo'])).toBeNull();
  });

  it('an exact listing is not an "equivalent"', () => {
    expect(findListedEquivalent(DATED, [DATED])).toBeNull();
  });
});

describe('claudeFamily', () => {
  it('reads the family from current and older id shapes', () => {
    expect(claudeFamily('claude-haiku-4-5')).toBe('haiku');
    expect(claudeFamily('anthropic/claude-3-5-haiku-20241022')).toBe('haiku');
    expect(claudeFamily('claude-opus-5')).toBe('opus');
    expect(claudeFamily('gpt-4o')).toBeNull();
    expect(claudeFamily('team-haiku')).toBeNull();
  });
});

describe('selectProbeModel', () => {
  it('(a) the user alias target of the verify model, when listed', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: { [DATED]: 'team-haiku' }, listed: ['team-haiku', DATED] }))
      .toEqual({ model: 'team-haiku', rule: 'alias' });
  });

  it('(a) the user alias target when the list is unavailable (today\'s behaviour)', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: { [DATED]: 'team-haiku' }, listed: null }))
      .toEqual({ model: 'team-haiku', rule: 'alias' });
  });

  it('(a) is skipped when the alias target is not listed', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: { [DATED]: 'gone-haiku' }, listed: [DATED] }))
      .toEqual({ model: DATED, rule: 'listed' });
  });

  it('(b) the verify model itself when listed', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['claude-opus-5', DATED] }))
      .toEqual({ model: DATED, rule: 'listed' });
  });

  it('(c) the same model under another name, prefix tolerated', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['claude-sonnet-5', 'claude-haiku-4-5'] }))
      .toEqual({ model: 'claude-haiku-4-5', rule: 'equivalent' });
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['anthropic/claude-haiku-4-5'] }))
      .toEqual({ model: 'anthropic/claude-haiku-4-5', rule: 'equivalent' });
  });

  it('(d) the cheapest listed Claude family: haiku < sonnet < opus', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['gpt-4o', 'claude-opus-5', 'claude-sonnet-5', 'claude-3-5-haiku'] }))
      .toEqual({ model: 'claude-3-5-haiku', rule: 'cheapest' });
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['claude-opus-5', 'claude-sonnet-5'] }))
      .toEqual({ model: 'claude-sonnet-5', rule: 'cheapest' });
  });

  it('(e) the first alias target, preferring one the endpoint lists', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: { 'claude-sonnet-5': 'team-sonnet', 'claude-opus-5': 'team-opus' }, listed: null }))
      .toEqual({ model: 'team-sonnet', rule: 'first-alias' });
    expect(selectProbeModel({ verifyModel: DATED, aliases: { 'claude-sonnet-5': 'team-sonnet', 'claude-opus-5': 'team-opus' }, listed: ['gpt-4o', 'team-opus'] }))
      .toEqual({ model: 'team-opus', rule: 'first-alias' });
  });

  it('(f) the verify model when nothing else applies', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: null })).toEqual({ model: DATED, rule: 'default' });
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: [] })).toEqual({ model: DATED, rule: 'default' });
    expect(selectProbeModel({ verifyModel: DATED, aliases: {}, listed: ['gpt-4o'] })).toEqual({ model: DATED, rule: 'default' });
  });

  it('an explicit alias wins over an equivalent the list offers', () => {
    expect(selectProbeModel({ verifyModel: DATED, aliases: { [DATED]: 'team-haiku' }, listed: ['team-haiku', 'claude-haiku-4-5'] }).model)
      .toBe('team-haiku');
  });
});

describe('deriveModelAliases', () => {
  const tierModels = ['claude-opus-5', 'claude-sonnet-5', DATED];

  it('maps a tier model the endpoint does not list to its listed same-model name', () => {
    expect(deriveModelAliases({ models: tierModels, explicit: {}, listed: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] }))
      .toEqual({ [DATED]: 'claude-haiku-4-5' });
  });

  it('never overrides an explicit alias, and never maps across families', () => {
    expect(deriveModelAliases({ models: tierModels, explicit: { [DATED]: 'team-haiku' }, listed: ['claude-haiku-4-5'] })).toEqual({});
    // Only a sonnet is listed: the haiku tier is not pointed at it.
    expect(deriveModelAliases({ models: tierModels, explicit: {}, listed: ['claude-sonnet-4-5'] })).toEqual({});
  });

  it('a listed model needs no alias; no list derives nothing', () => {
    expect(deriveModelAliases({ models: tierModels, explicit: {}, listed: tierModels })).toEqual({});
    expect(deriveModelAliases({ models: tierModels, explicit: {}, listed: null })).toEqual({});
  });

  it('tolerates a provider/ prefix', () => {
    expect(deriveModelAliases({ models: [DATED], explicit: {}, listed: ['anthropic/claude-haiku-4-5'] }))
      .toEqual({ [DATED]: 'anthropic/claude-haiku-4-5' });
  });
});

describe('usableListedModels', () => {
  it('Claude models, cheapest family first, at most a few', () => {
    expect(usableListedModels(['gpt-4o', 'claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-5'], 3))
      .toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-4-5']);
    expect(usableListedModels(['gpt-4o'])).toEqual([]);
  });
});

describe('parseModelList', () => {
  it('reads OpenAI-style and Anthropic-style lists', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'claude-haiku-4-5', object: 'model' }, { id: 'gpt-4o' }] })).toEqual(['claude-haiku-4-5', 'gpt-4o']);
    expect(parseModelList({ data: [{ id: 'claude-haiku-4-5', type: 'model' }], has_more: true, first_id: 'x' })).toEqual(['claude-haiku-4-5']);
  });

  it('anything else is unavailable; junk ids are dropped; the list is capped', () => {
    expect(parseModelList({})).toBeNull();
    expect(parseModelList([])).toBeNull();
    expect(parseModelList({ data: 'x' })).toBeNull();
    expect(parseModelList({ data: [{ id: 'ok' }, { id: 'has space' }, { id: 7 }, { id: 'x'.repeat(300) }, null, { id: 'ok' }] })).toEqual(['ok']);
    const many = { data: Array.from({ length: MAX_LISTED_MODELS + 50 }, (_, i) => ({ id: `m-${i}` })) };
    expect(parseModelList(many)).toHaveLength(MAX_LISTED_MODELS);
  });
});

describe('listAgentEndpointModels', () => {
  const route = { baseUrl: 'https://litellm.example.com', apiKey: 'sk-agent-example', authHeader: 'x-api-key' as const };
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

  it('GETs /v1/models with the configured header, no redirects', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const ids = await listAgentEndpointModels(route, { lookup: publicLookup, fetcher: async (url, init) => { seen = { url, init }; return json({ data: [{ id: 'claude-haiku-4-5' }] }); } });
    expect(ids).toEqual(['claude-haiku-4-5']);
    expect(seen!.url).toBe('https://litellm.example.com/v1/models');
    expect(seen!.init?.method ?? 'GET').toBe('GET');
    expect(seen!.init?.redirect).toBe('manual');
    expect(new Headers(seen!.init?.headers).get('x-api-key')).toBe('sk-agent-example');
  });

  it('bearer auth when configured', async () => {
    let h: Headers | null = null;
    await listAgentEndpointModels({ ...route, authHeader: 'authorization' }, { lookup: publicLookup, fetcher: async (_u, init) => { h = new Headers(init?.headers); return json({ data: [] }); } });
    expect(h!.get('authorization')).toBe('Bearer sk-agent-example');
    expect(h!.get('x-api-key')).toBeNull();
  });

  it('404, 405, 401, non-JSON, a redirect, a thrown fetch, a private host: null', async () => {
    for (const res of [json({}, 404), json({}, 405), json({}, 401), new Response('<html>', { status: 200 }), new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })]) {
      expect(await listAgentEndpointModels(route, { lookup: publicLookup, fetcher: async () => res })).toBeNull();
    }
    expect(await listAgentEndpointModels(route, { lookup: publicLookup, fetcher: async () => { throw new Error('boom'); } })).toBeNull();
    let called = false;
    expect(await listAgentEndpointModels(route, { lookup: async () => [{ address: '10.0.0.1', family: 4 }], fetcher: async () => { called = true; return json({ data: [] }); } })).toBeNull();
    expect(called).toBe(false);
  });

  it('a body over the size bound is unavailable', async () => {
    const huge = JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }], pad: 'x'.repeat(2_000_000) });
    expect(await listAgentEndpointModels(route, { lookup: publicLookup, fetcher: async () => new Response(huge) })).toBeNull();
  });
});

describe('matchListedModel (normalised across providers)', () => {
  it('strips provider/ prefixes, dates and dots vs dashes', () => {
    const listed = ['claude-haiku-4-5', 'gemini-2-5-flash', 'openai/gpt-4o-mini'];
    expect(matchListedModel('anthropic/claude-haiku-4.5', listed)).toBe('claude-haiku-4-5');
    expect(matchListedModel('claude-haiku-4-5-20251001', listed)).toBe('claude-haiku-4-5');
    expect(matchListedModel('google/gemini-2.5-flash', listed)).toBe('gemini-2-5-flash');
    expect(matchListedModel('gpt-4o-mini', listed)).toBe('openai/gpt-4o-mini');
    expect(matchListedModel('claude-haiku-4-5@20251001', listed)).toBe('claude-haiku-4-5');
  });

  it('an exact listing beats a normalised one; no match is null', () => {
    expect(matchListedModel('claude-haiku-4-5', ['anthropic/claude-haiku-4-5', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5');
    expect(matchListedModel('claude-haiku-4-5', ['claude-haiku-4'])).toBeNull();
    expect(matchListedModel('claude-haiku-4-5', [])).toBeNull();
  });
});

describe('buildEndpointModelRows', () => {
  const wanted = [
    { model: 'claude-sonnet-5', tiers: ['standard'] },
    { model: DATED, tiers: ['budget'] },
    { model: 'claude-opus-5', tiers: ['premium'] },
  ];

  it('precedence: explicit alias > listed as is > registry mapping > same-model equivalent', () => {
    const rows = buildEndpointModelRows({
      wanted,
      explicit: { 'claude-opus-5': 'team-opus' },
      // The team routes budget elsewhere to a non-Claude model on purpose.
      hints: { [DATED]: ['google/gemini-2.5-flash'], 'claude-sonnet-5': ['openai/gpt-4o'] },
      listed: ['claude-sonnet-5', 'claude-haiku-4-5', 'gemini-2-5-flash', 'team-opus', 'gpt-4o'],
    });
    expect(rows).toEqual([
      { model: 'claude-sonnet-5', tiers: ['standard'], value: null, source: 'listed', served: true },
      { model: DATED, tiers: ['budget'], value: 'gemini-2-5-flash', source: 'registry', served: true },
      { model: 'claude-opus-5', tiers: ['premium'], value: 'team-opus', source: 'alias', served: true },
    ]);
  });

  it('falls back to the same-model equivalent, then to unserved', () => {
    const rows = buildEndpointModelRows({ wanted, explicit: {}, hints: {}, listed: ['claude-haiku-4-5', 'gpt-4o'] });
    expect(rows.map((r) => [r.model, r.value, r.source, r.served])).toEqual([
      ['claude-sonnet-5', null, null, false],
      [DATED, 'claude-haiku-4-5', 'equivalent', true],
      ['claude-opus-5', null, null, false],
    ]);
  });

  it('an explicit alias the endpoint does not list is kept, marked unserved', () => {
    const [row] = buildEndpointModelRows({ wanted: [wanted[0]], explicit: { 'claude-sonnet-5': 'gone' }, hints: {}, listed: ['claude-haiku-4-5'] });
    expect(row).toEqual({ model: 'claude-sonnet-5', tiers: ['standard'], value: 'gone', source: 'alias', served: false });
  });

  it('a registry hint that is not listed is ignored', () => {
    const [row] = buildEndpointModelRows({ wanted: [wanted[1]], explicit: {}, hints: { [DATED]: ['some/unlisted'] }, listed: ['claude-haiku-4-5'] });
    expect(row.source).toBe('equivalent');
  });

  it('explicit aliases for models buildd does not ask for become their own rows (nothing is dropped)', () => {
    const rows = buildEndpointModelRows({ wanted: [wanted[0]], explicit: { 'claude-legacy-1': 'team-legacy' }, hints: {}, listed: ['claude-sonnet-5', 'team-legacy'] });
    expect(rows.map((r) => r.model)).toEqual(['claude-sonnet-5', 'claude-legacy-1']);
    expect(rows[1]).toMatchObject({ value: 'team-legacy', source: 'alias', tiers: [] });
  });
});

describe('suggestionCandidates', () => {
  it('caps the list and ranks lexically close ids first', () => {
    const listed = [...Array.from({ length: 40 }, (_, i) => `vendor/other-${i}`), 'team-haiku-fast', 'claude-haiku-3'];
    const c = suggestionCandidates(DATED, listed, 20);
    expect(c).toHaveLength(20);
    expect(c.slice(0, 2).sort()).toEqual(['claude-haiku-3', 'team-haiku-fast']);
  });

  it('short lists pass through whole', () => {
    expect(suggestionCandidates(DATED, ['a', 'b'], 20).sort()).toEqual(['a', 'b']);
  });
});
