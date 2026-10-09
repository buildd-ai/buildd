import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionNoticeSlot, { noticeNeedsPerson } from './MissionNoticeSlot';

describe('MissionNoticeSlot', () => {
  it('is an L3 decision card only when a person has to act', () => {
    const html = renderToStaticMarkup(<MissionNoticeSlot needsYou><p>Decide</p></MissionNoticeSlot>);
    expect(html).toContain('card-decision');
    expect(html).toContain('data-level="3"');
  });

  it('is a quiet hairline block when Buildd is handling it', () => {
    const html = renderToStaticMarkup(<MissionNoticeSlot needsYou={false}><p>Repairing</p></MissionNoticeSlot>);
    expect(html).not.toContain('card-decision');
    expect(html).not.toMatch(/class="[^"]*\bcard\b/);
    expect(html).toContain('data-level="1"');
  });

  it('renders nothing when it has nothing to say', () => {
    expect(renderToStaticMarkup(<MissionNoticeSlot needsYou>{null}{false}</MissionNoticeSlot>)).toBe('');
  });
});

describe('noticeNeedsPerson', () => {
  it('a decision gate or an exhausted budget always needs a person', () => {
    expect(noticeNeedsPerson({ displayState: 'waiting_decision', budgetExhausted: false, focusKind: null })).toBe(true);
    expect(noticeNeedsPerson({ displayState: 'active', budgetExhausted: true, focusKind: null })).toBe(true);
  });

  it('a decision, a merge or a closed PR needs a person', () => {
    for (const k of ['human_decision', 'merge', 'pr_closed_unmerged', 'criterion_failing'] as const) {
      expect(noticeNeedsPerson({ displayState: 'blocked', budgetExhausted: false, focusKind: k })).toBe(true);
    }
  });

  it('what Buildd resolves on its own is not a decision: CI repair, a wait, a dependency, an unverified criterion', () => {
    for (const k of ['ci_red', 'self_resolving_wait', 'dependency', 'claim_deferral', 'criterion_unverified', 'task'] as const) {
      expect(noticeNeedsPerson({ displayState: 'blocked', budgetExhausted: false, focusKind: k })).toBe(false);
    }
    expect(noticeNeedsPerson({ displayState: 'blocked', budgetExhausted: false, focusKind: null })).toBe(false);
  });
});
