import { describe, expect, it } from 'bun:test';
import { MODELS_QA_DECISIONS, resolveModelsQaDecisions } from './qa-state';

describe('resolveModelsQaDecisions', () => {
  it('returns the decisions fixture on the dev server only', () => {
    expect(resolveModelsQaDecisions('decisions', 'development')).toBe(MODELS_QA_DECISIONS);
    expect(resolveModelsQaDecisions(['decisions'], 'development')).toBe(MODELS_QA_DECISIONS);
    expect(resolveModelsQaDecisions('decisions', 'production')).toBeNull();
    expect(resolveModelsQaDecisions('decisions', 'test')).toBeNull();
  });

  it('ignores any other state', () => {
    expect(resolveModelsQaDecisions(undefined, 'development')).toBeNull();
    expect(resolveModelsQaDecisions('other', 'development')).toBeNull();
  });

  it('the fixture holds overrides and an undoable switch line', () => {
    expect(MODELS_QA_DECISIONS.overrides.length).toBeGreaterThan(0);
    expect(MODELS_QA_DECISIONS.switches.lines.length).toBeGreaterThan(0);
    expect(MODELS_QA_DECISIONS.switches.canUndo).toBe(true);
  });
});
