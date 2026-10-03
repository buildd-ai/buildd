import { describe, expect, it } from 'bun:test';
import {
  CODE_RUBRIC,
  GOAL_QUALITY_BASELINE_RUBRIC,
  RUBRIC_ENTRY_MAX_CHARS,
  RUBRIC_MAX_CHARS,
  acceptedPatternMemory,
  composeGoalQualityRubric,
  criterionShape,
  loadGoalQualityRubric,
  type RubricMemoryReader,
} from './goal-criteria-rubric';

const entry = (content: string, tags: string[] = [], updatedAt = '2026-09-01T00:00:00.000Z') => ({ content, tags, updatedAt });

describe('composeGoalQualityRubric', () => {
  it('an empty memory is the code default, versioned base', () => {
    expect(composeGoalQualityRubric({})).toEqual(CODE_RUBRIC);
    expect(CODE_RUBRIC.text).toBe(GOAL_QUALITY_BASELINE_RUBRIC);
    expect(CODE_RUBRIC.version).toBe('base');
  });

  it('a team baseline replaces the code default and changes the version', () => {
    const r = composeGoalQualityRubric({ baseline: 'Our goals name a customer.' });
    expect(r.text).toBe('Our goals name a customer.');
    expect(r.version).toMatch(/^m[0-9a-f]{8}$/);
  });

  it('notes and accepted patterns follow the baseline; accepted fingerprints come from the fp: tag', () => {
    const r = composeGoalQualityRubric({
      notes: [entry('Internal tools count the owner as the user.')],
      accepted: [entry('kept a labelled command', ['goal-criteria-accepted', 'fp:command:abc'])],
    });
    expect(r.text.startsWith(GOAL_QUALITY_BASELINE_RUBRIC)).toBe(true);
    expect(r.text).toContain('Workspace note: Internal tools count the owner as the user.');
    expect(r.text).toContain('Accepted in this workspace: kept a labelled command');
    expect(r.acceptedFingerprints).toEqual(['command:abc']);
  });

  it('each entry is cut to its cap and the whole to the total, oldest accepted dropped first', () => {
    const long = 'x'.repeat(RUBRIC_ENTRY_MAX_CHARS * 2);
    const notes = Array.from({ length: 5 }, () => entry(long));
    const accepted = Array.from({ length: 20 }, (_, i) => entry(`a${i} ${long}`, [`fp:command:${i}`]));
    const r = composeGoalQualityRubric({ notes, accepted });
    expect(r.text.length).toBeLessThanOrEqual(RUBRIC_MAX_CHARS);
    expect(r.text).toContain('Accepted in this workspace: a0 ');
    expect(r.text).not.toContain('a19 ');
    // Suppression is by fingerprint and survives a dropped text.
    expect(r.acceptedFingerprints).toHaveLength(20);
  });

  it('the same inputs give the same version; different ones a different version', () => {
    const a = composeGoalQualityRubric({ notes: [entry('one')] });
    expect(composeGoalQualityRubric({ notes: [entry('one')] }).version).toBe(a.version);
    expect(composeGoalQualityRubric({ notes: [entry('two')] }).version).not.toBe(a.version);
  });
});

describe('accepted pattern memory', () => {
  it('describes shape, never the criterion text', () => {
    const c = { type: 'command' as const, command: 'bun run scripts/secret.ts', label: 'customer can export invoices' };
    const m = acceptedPatternMemory(c, 'command:zz', 'acme/app');
    expect(criterionShape(c)).toBe('command, labelled');
    expect(JSON.stringify(m)).not.toContain('secret');
    expect(JSON.stringify(m)).not.toContain('invoices');
    expect(m.tags).toEqual(['goal-criteria-rubric', 'goal-criteria-accepted', 'fp:command:zz']);
    expect(m.type).toBe('pattern');
  });
});

describe('loadGoalQualityRubric — fails open', () => {
  const rows = {
    base: { id: 'b', content: 'Team baseline.', tags: ['goal-criteria-rubric'], updatedAt: '2026-09-02T00:00:00.000Z' },
    note: { id: 'n', content: 'A note.', tags: ['goal-criteria-rubric'], updatedAt: '2026-09-02T00:00:00.000Z' },
    acc: { id: 'a', content: 'Kept.', tags: ['goal-criteria-rubric', 'goal-criteria-accepted', 'fp:command:f1'], updatedAt: '2026-09-02T00:00:00.000Z' },
  };
  const store = (): RubricMemoryReader & { calls: any[] } => {
    const calls: any[] = [];
    return {
      calls,
      async search(p) {
        calls.push(p);
        if (p.teamWide) return { results: [{ id: 'b' } as any] };
        if (p.type === 'decision') return { results: [{ id: 'n' } as any] };
        return { results: [{ id: 'a' } as any] };
      },
      async batch(ids) { return { memories: ids.map(id => (Object.values(rows) as any[]).find(r => r.id === id)) }; },
    };
  };

  it('reads the team baseline, workspace notes and accepted patterns, active only', async () => {
    const s = store();
    const r = await loadGoalQualityRubric({ teamId: 't', workspaceId: 'w' }, { store: s, resolveProject: async () => 'acme/app' });
    expect(r.text).toContain('Team baseline.');
    expect(r.text).toContain('A note.');
    expect(r.acceptedFingerprints).toEqual(['command:f1']);
    expect(s.calls.every(c => c.states?.[0] === 'active' && c.states.length === 1)).toBe(true);
    expect(s.calls.filter(c => c.project === 'acme/app')).toHaveLength(2);
  });

  it('a sensitive or unscoped workspace (no project key) reads the team baseline only', async () => {
    const s = store();
    const r = await loadGoalQualityRubric({ teamId: 't', workspaceId: 'w' }, { store: s, resolveProject: async () => null });
    expect(s.calls).toHaveLength(1);
    expect(r.acceptedFingerprints).toEqual([]);
  });

  it('a throwing read is the code default (AC-11)', async () => {
    const r = await loadGoalQualityRubric({ teamId: 't', workspaceId: 'w' }, {
      store: { search: async () => { throw new Error('db down'); }, batch: async () => ({ memories: [] }) },
      resolveProject: async () => 'acme/app',
    });
    expect(r).toEqual(CODE_RUBRIC);
  });

  it('a hanging read is the code default after the timeout', async () => {
    const r = await loadGoalQualityRubric({ teamId: 't', workspaceId: 'w' }, {
      store: { search: () => new Promise(() => {}), batch: async () => ({ memories: [] }) },
      resolveProject: async () => 'acme/app',
      timeoutMs: 10,
    });
    expect(r).toEqual(CODE_RUBRIC);
  });

  it('no rows is the code default', async () => {
    const r = await loadGoalQualityRubric({ teamId: 't', workspaceId: 'w' }, {
      store: { search: async () => ({ results: [] }), batch: async () => ({ memories: [] }) },
      resolveProject: async () => 'acme/app',
    });
    expect(r).toEqual(CODE_RUBRIC);
  });
});
