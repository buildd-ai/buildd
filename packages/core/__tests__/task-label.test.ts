import { describe, it, expect } from 'bun:test';
import {
  taskDisplayLabel,
  heuristicTaskLabel,
  normalizeTaskLabel,
  TASK_LABEL_MAX_LENGTH,
} from '../task-label';

/**
 * The redesign draws every task as a scope chip + a 2–4 word label. Whoever
 * files the task may supply `label`; otherwise the heuristic derives one from
 * the title. These cases pin the heuristic's behaviour on real-shaped titles.
 */
describe('taskDisplayLabel — heuristic', () => {
  const cases: Array<[string, string | null, string]> = [
    ['feat(fx): rates service with a 15-minute cache and stale-rate fallback', 'fx', 'rates service'],
    ['fix(ci): add role_name parameter to Neon connection_uri request', 'ci', 'role_name parameter'],
    ['fix(claim): a task never path-overlap-blocks on its own open PR', 'claim', 'task never path-overlap-blocks'],
    ['fix(deps): update dependency @openai/codex-sdk to ^0.157.0', 'deps', 'update dependency'], // 4th word would exceed the 32-char chip cap,
    ['refactor!: drop the legacy worker table', null, 'drop legacy worker table'],
    ['docs: rewrite the testing guide', null, 'rewrite testing guide'],
    ['Add support for dark mode in the settings page', null, 'support dark mode'],
    ['Investigate why runners stall after budget reset', null, 'investigate why runners stall'],
    ['Rates Service Rollout — phase two', null, 'rates service rollout'],
  ];

  for (const [title, scope, label] of cases) {
    it(`${title} → [${scope}] ${label}`, () => {
      expect(taskDisplayLabel({ title })).toEqual({ scope, label });
    });
  }

  it('retry titles inherit the underlying task label', () => {
    expect(
      taskDisplayLabel({ title: '[builder · after CI #1] feat(fx): rates service with a 15-minute cache' }),
    ).toEqual({ scope: 'fx', label: 'rates service' });
    expect(taskDisplayLabel({ title: '[CI Retry] fix(claim): tighten the overlap gate' }))
      .toEqual({ scope: 'claim', label: 'tighten overlap gate' });
    expect(taskDisplayLabel({ title: '[reviewer retry] [CI Retry] feat(ui): new home page' }))
      .toEqual({ scope: 'ui', label: 'new home page' });
  });

  it('organizer "Mission:" titles label the mission subject', () => {
    expect(taskDisplayLabel({ title: 'Mission: FX rates service with caching' }))
      .toEqual({ scope: null, label: 'FX rates service' });
  });

  it('"Verify goal criterion:" titles read as a verify step', () => {
    expect(taskDisplayLabel({ title: 'Verify goal criterion: all PRs merged and branch deleted' }))
      .toEqual({ scope: null, label: 'verify all PRs merged' });
  });

  // Regression: a researcher title labelled as the bare prefix "RESEARCH", so
  // the task page's "Also running" drew it in raw caps beside short labels.
  it('"RESEARCH:" titles label the research subject, not the prefix', () => {
    expect(taskDisplayLabel({ title: "RESEARCH: FX rate providers — freshness, cost, and what breaks when they're down" }))
      .toEqual({ scope: null, label: 'FX rate providers' });
    expect(taskDisplayLabel({ title: 'research: where PDF render time goes' }).label)
      .not.toMatch(/^research$/i);
  });

  it('keeps acronyms and code identifiers verbatim', () => {
    expect(taskDisplayLabel({ title: 'fix(api): MCP create_task rejects label' }).label)
      .toBe('MCP create_task rejects label');
  });

  it('caps a single overlong word', () => {
    const { label } = taskDisplayLabel({ title: 'x'.repeat(200) });
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label.endsWith('…')).toBe(true);
  });

  it('never returns an empty label', () => {
    expect(taskDisplayLabel({ title: '' }).label).toBe('untitled');
    expect(taskDisplayLabel({ title: '   ' }).label).toBe('untitled');
    expect(taskDisplayLabel({ title: 'feat(x):' })).toEqual({ scope: 'x', label: 'untitled' });
    expect(taskDisplayLabel({ title: 'the a an' }).label).toBe('the a an');
  });

  it('does not treat a non-type word before a colon as a conventional type', () => {
    expect(taskDisplayLabel({ title: 'Heads up: the claim route is slow' }))
      .toEqual({ scope: null, label: 'heads up' });
  });

  it('is deterministic', () => {
    const t = { title: 'feat(core): short task labels for the redesign' };
    expect(taskDisplayLabel(t)).toEqual(taskDisplayLabel(t));
  });

  it('heuristicTaskLabel ignores any stored label', () => {
    expect(heuristicTaskLabel('feat(fx): rates service with cache').label).toBe('rates service');
  });
});

describe('taskDisplayLabel — creator-supplied label', () => {
  it('prefers task.label and still parses the scope from the title', () => {
    expect(taskDisplayLabel({ label: 'FX rates', title: 'feat(fx): rates service with a cache' }))
      .toEqual({ scope: 'fx', label: 'FX rates' });
  });

  it('falls back to the heuristic for null / blank labels', () => {
    expect(taskDisplayLabel({ label: null, title: 'feat(fx): rates service' }).label).toBe('rates service');
    expect(taskDisplayLabel({ label: '   ', title: 'feat(fx): rates service' }).label).toBe('rates service');
  });
});

describe('normalizeTaskLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeTaskLabel('  rates   service \n')).toBe('rates service');
  });
  it('returns null for blank / non-string', () => {
    expect(normalizeTaskLabel('')).toBeNull();
    expect(normalizeTaskLabel('   ')).toBeNull();
    expect(normalizeTaskLabel(undefined)).toBeNull();
    expect(normalizeTaskLabel(null)).toBeNull();
    expect(normalizeTaskLabel(42 as unknown)).toBeNull();
  });
  it('caps at the column width on a word boundary', () => {
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const out = normalizeTaskLabel(long)!;
    expect(out.length).toBeLessThanOrEqual(TASK_LABEL_MAX_LENGTH);
    expect(long.startsWith(out)).toBe(true);
    expect(out.endsWith(' ')).toBe(false);
  });
});
