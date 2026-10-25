import { describe, expect, it } from 'bun:test';
import { criterionShortName, criterionTextKey, goalCriteriaUnmet, unmetRequirements, unmetSummary } from './spec-criterion-words';

describe('criterionShortName', () => {
  it('keeps a short requirement whole, without markdown or its id', () => {
    expect(criterionShortName('R-3: The **WSL2 install step** runs from `setup.ps1`.')).toBe('The WSL2 install step runs from setup.ps1');
  });
  it('stops at the first clause and clips at a word', () => {
    expect(criterionShortName('Runner starts on boot, without a terminal window open, and reconnects after sleep')).toBe('Runner starts on boot');
    const long = criterionShortName('One guided setup covers installing the distribution and the runner service together in a single pass');
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });
  it('reads a link as its words', () => {
    expect(criterionShortName('Docs link to [the WSL guide](https://example.test/wsl)')).toBe('Docs link to the WSL guide');
  });
});

describe('unmetRequirements', () => {
  const texts = new Map([
    ['R-1', 'WSL2 install step'],
    ['R-2', 'Runner starts on boot, every time'],
    ['R-3', 'Setup reports progress'],
    ['AC-1', 'A failed step says what to change'],
  ]);
  it('names each open requirement in words, never by id, under one state word', () => {
    const u = unmetRequirements({ open: [{ standing: 'missing', criterionIds: ['R-1', 'R-2', 'R-3', 'AC-1'] }], texts });
    expect(u.count).toBe(4);
    expect(u.state).toBe('not checked');
    expect(u.names).toEqual(['WSL2 install step', 'Runner starts on boot', 'Setup reports progress', 'A failed step says what to change']);
  });
  it('mixed standings read as not passing; a criterion with no text counts but is not named', () => {
    const u = unmetRequirements({ open: [{ standing: 'fail', criterionIds: ['R-1'] }, { standing: 'missing', criterionIds: ['R-9'] }], texts });
    expect(u).toEqual({ count: 2, state: 'not passing', names: ['WSL2 install step'] });
  });
});

describe('unmetSummary', () => {
  it('names up to three, then the rest as a count, and says what waits', () => {
    const s = unmetSummary({ count: 4, state: 'not checked', names: ['WSL2 install step', 'Runner starts on boot', 'Setup reports progress', 'Errors say what to change'] });
    expect(s).toBe('4 requirements not checked: WSL2 install step, Runner starts on boot, Setup reports progress and 1 more. The mission finishes once these pass or are waived.');
  });
  it('one requirement reads in the singular', () => {
    expect(unmetSummary({ count: 1, state: 'not met', names: ['WSL2 install step'] })).toBe('1 requirement not met: WSL2 install step. The mission finishes once it passes or is waived.');
  });
  it('with no names, the count alone', () => {
    expect(unmetSummary({ count: 2, state: 'not checked', names: [] })).toBe('2 requirements not checked. The mission finishes once these pass or are waived.');
  });
});

describe('goalCriteriaUnmet (the page assembly)', () => {
  const texts = new Map([
    [criterionTextKey('s1', 'R-1'), 'WSL2 install step'],
    [criterionTextKey('s1', 'R-2'), 'Runner starts on boot'],
    [criterionTextKey('s1', 'R-3'), 'Setup reports progress'],
  ]);
  const spec = { type: 'living_spec', specId: 's1', revision: 1 } as const;
  const entry = (standings: { criterionId: string; standing: string }[], verdict = 'UNVERIFIED') => ({
    evaluatedAt: 'x', evaluatedBy: 'auto', overall: verdict,
    criteria: [{ index: 0, type: 'living_spec', verdict, spec: { specId: 's1', revision: 1, targetSha: null, standings: standings.map(s => ({ ...s, headSha: null })) } }],
  }) as never;

  it('names the open criteria of a checked spec, skipping the passes', () => {
    const u = goalCriteriaUnmet({ criteria: [spec as never], state: entry([{ criterionId: 'R-1', standing: 'pass' }, { criterionId: 'R-2', standing: 'missing' }, { criterionId: 'R-3', standing: 'missing' }]), texts });
    expect(u).toEqual({ count: 2, state: 'not checked', names: ['Runner starts on boot', 'Setup reports progress'] });
  });
  it('a spec never checked holds every requirement in scope, less the waived', () => {
    const u = goalCriteriaUnmet({ criteria: [{ ...spec, waived: [{ criterionId: 'R-3', reason: 'later' }] } as never], state: null, texts });
    expect(u).toEqual({ count: 2, state: 'not checked', names: ['WSL2 install step', 'Runner starts on boot'] });
  });
  it('another criterion is named by its label; a passing mission has none open', () => {
    const cmd = { type: 'command', command: 'bun run test', label: 'Unit tests pass' } as never;
    const state = { evaluatedAt: 'x', evaluatedBy: 'auto', overall: 'fail', criteria: [{ index: 0, type: 'command', verdict: 'fail' }] } as never;
    expect(goalCriteriaUnmet({ criteria: [cmd], state, texts })).toEqual({ count: 1, state: 'not met', names: ['Unit tests pass'] });
    const passed = { evaluatedAt: 'x', evaluatedBy: 'auto', overall: 'pass', criteria: [{ index: 0, type: 'command', verdict: 'pass' }] } as never;
    expect(goalCriteriaUnmet({ criteria: [cmd], state: passed, texts })).toBeNull();
  });
});
