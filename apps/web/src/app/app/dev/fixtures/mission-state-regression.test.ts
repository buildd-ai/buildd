/**
 * Mission lifecycle regression suite (Mission state Living Spec, I-10..I-12 and
 * AC-11..AC-16). Six canonical lifecycle fixtures run through the real card
 * builders; the assertions are about what the mission page, the card and the
 * list card all say, so the three can not drift apart without a failure here.
 *
 *   bun run scripts/run-unit-tests.ts apps/web/src/app/app/dev/fixtures/mission-state-regression.test.ts
 *
 * Traceability (spec criteria, by what each block pins):
 *   AC-11  a new mission with its organizer queued does not ask for verification
 *   AC-12  an organizer that is working is planning, not awaiting verification
 *   AC-13  active implementation reads as work, criteria stay visible but quiet
 *   AC-14  an open PR is the one ask, ahead of verification
 *   AC-15  verification is the primary ask only once the work has landed
 *   AC-16  every view model agrees on state, next action and criteria; delivered is quiet
 *
 * KNOWN GAP: `criteriaFact` outranks the organizer's planning state, so AC-11
 * and AC-12 fail today. Those cases are `it.failing` (they assert the CORRECT
 * behaviour and flip red the moment the fix lands, which is the cue to turn
 * them into plain `it`). Fix tracked outside this suite; no production code is
 * changed here.
 */
import { describe, expect, it } from 'bun:test';
import { missionLifecycleFixtures, type MissionLifecycleFixture, type MissionLifecycleKey } from './mission-state-regression-fixtures';

const fixtures = missionLifecycleFixtures(Date.UTC(2026, 9, 17, 12));
const fx = (key: MissionLifecycleKey): MissionLifecycleFixture => fixtures.find(f => f.key === key)!;

const asksForVerification = (f: MissionLifecycleFixture) =>
  f.view.situation.focus?.kind === 'criterion_unverified'
  || f.view.chip.label === 'AWAITING VERIFICATION'
  || /verif/i.test(f.view.situation.headline)
  || /verif/i.test(f.view.situation.nextAction ?? '')
  || /verif/i.test(f.model.sentence ?? '');

describe('lifecycle fixtures cover the six canonical states', () => {
  it('in order, each built from the real builders', () => {
    expect(fixtures.map(f => f.key)).toEqual([
      'new-organizer-queued', 'organizer-working', 'implementation-active', 'awaiting-mission-pr-merge', 'verification-due', 'delivered',
    ]);
  });
});

describe('AC-11: a new mission with the organizer queued and unverified criteria does not ask for verification', () => {
  it.failing('no verification chip, focus, headline or next action', () => {
    expect(asksForVerification(fx('new-organizer-queued'))).toBe(false);
  });
  it.failing('it is not in the attention group and does not read "Waiting on you"', () => {
    const f = fx('new-organizer-queued');
    expect(f.view.group).not.toBe('attention');
    expect(f.model.status.label).not.toBe('Waiting on you');
  });
  it('the criteria are still shown, as future requirements (0 of 2)', () => {
    expect(fx('new-organizer-queued').model.criteria).toEqual({ passed: 0, total: 2 });
  });
});

describe('AC-12: a working organizer is planning, not awaiting verification', () => {
  it.failing('nothing about verification in the headline, next action or sentence', () => {
    expect(asksForVerification(fx('organizer-working'))).toBe(false);
  });
  it('it is running, with the organizer live', () => {
    const f = fx('organizer-working');
    expect(f.view.group).toBe('running');
    expect(f.model.live.dots.map(d => d.roleSlug)).toEqual(['organizer']);
  });
});

describe('AC-13: active implementation reads as work', () => {
  const f = fx('implementation-active');
  it('running, the focus is the open tasks, and verification is not asked for', () => {
    expect(f.view.chip.label).toBe('RUNNING');
    expect(f.view.situation.focus?.kind).toBe('task');
    expect(asksForVerification(f)).toBe(false);
  });
  it('the criteria stay visible and unmet', () => {
    expect(f.model.criteria).toEqual({ passed: 0, total: 2 });
  });
});

describe('AC-14: an open PR is the one ask', () => {
  const f = fx('awaiting-mission-pr-merge');
  it('the focus is the merge, with a Merge action, and no verification ask', () => {
    expect(f.view.situation.focus?.kind).toBe('merge');
    expect(f.view.primary?.label).toMatch(/^Merge:/);
    expect(f.model.ask?.label).toMatch(/^Merge:/);
    expect(asksForVerification(f)).toBe(false);
  });
});

describe('AC-15: verification is the primary ask once the work has landed', () => {
  const f = fx('verification-due');
  it('awaiting verification, with the run-verification next action', () => {
    expect(f.view.chip.label).toBe('AWAITING VERIFICATION');
    expect(f.view.situation.focus?.kind).toBe('criterion_unverified');
    expect(f.view.situation.nextAction).toMatch(/verification/i);
    expect(f.view.group).toBe('attention');
  });
});

describe('AC-16: delivered is quiet, and every view model agrees', () => {
  it('a delivered mission asks for nothing and shows its criteria passed', () => {
    const f = fx('delivered');
    expect(f.view.chip.label).toBe('COMPLETE');
    expect(f.view.situation.nextAction).toBeNull();
    expect(f.model.kind).toBe('done');
    expect(f.model.criteria).toEqual({ passed: 2, total: 2 });
    expect(asksForVerification(f)).toBe(false);
  });

  it.each(fixtures.map(f => [f.key, f] as const))('%s: the list card says what the card view says', (_key, f) => {
    // One sentence, from one derivation: the list card never words the state itself.
    if (f.model.sentence) expect(f.view.situation.headline).toContain(f.model.sentence);
    // The same gate decides "needs you" in both.
    expect(f.model.status.label === 'Waiting on you').toBe(f.view.group === 'attention' || f.view.group === 'review');
    // Criteria are present on every state, as a fraction of the same two.
    expect(f.model.criteria?.total).toBe(2);
    // The caption and the list card count the same tasks.
    expect(f.model.counts.total).toBe(f.view.total);
  });
});
