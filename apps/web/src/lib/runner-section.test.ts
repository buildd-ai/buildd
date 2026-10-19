import { describe, it, expect } from 'bun:test';
import { runnerSection } from './runner-heartbeats-shared';

describe('runnerSection: Health puts a runner by its ownership class', () => {
  it('a personal runner made by the viewer is theirs', () => {
    expect(runnerSection({ runnerClass: 'personal', mine: true })).toBe('mine');
  });
  it("a teammate's personal runner, including one from another team, is the team's list", () => {
    expect(runnerSection({ runnerClass: 'personal', mine: false })).toBe('team');
  });
  it('a managed or team-host runner is shared, even when the viewer minted its key', () => {
    expect(runnerSection({ runnerClass: 'managed', mine: true })).toBe('team');
    expect(runnerSection({ runnerClass: 'team', mine: true })).toBe('team');
  });
  it('an unclassified runner keeps the creator rule', () => {
    expect(runnerSection({ runnerClass: 'unknown', mine: true })).toBe('mine');
    expect(runnerSection({ mine: false })).toBe('team');
  });
});
