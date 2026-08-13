import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InitiativeTriageRow } from './InitiativeTriageRow';
import type { EffortDay } from '@/components/SparklineBar';

const emptyDays: EffortDay[] = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-07-${String(31 - 13 + i).padStart(2, '0')}`,
  tokens: 0,
  merged: 0,
  failed: 0,
  open: 0,
}));

const baseProps = {
  id: 'abc123',
  title: 'Test Initiative',
  progress: 42,
  effortDays: emptyDays,
  awaitingVerification: 0,
  blocked: 0,
  held: 0,
  shippedThisWeek: 0,
  isDormant: false,
};

describe('InitiativeTriageRow', () => {
  // AC-14: no subline when all-quiet
  it('renders no subline when all counts are zero', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow {...baseProps} />);
    expect(html).not.toContain('awaiting');
    expect(html).not.toContain('blocked');
    expect(html).not.toContain('held');
    expect(html).not.toContain('shipped');
  });

  // AC-15: multiple conditions separated by ·
  it('renders all true conditions separated by · (awaiting + blocked)', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} awaitingVerification={2} blocked={1} />,
    );
    expect(html).toContain('2 awaiting merge');
    expect(html).toContain('1 blocked');
    expect(html).toContain('·');
  });

  it('renders only awaiting merge when only awaitingVerification > 0', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} awaitingVerification={3} />,
    );
    expect(html).toContain('3 awaiting merge');
    expect(html).not.toContain('blocked');
    expect(html).not.toContain('shipped');
  });

  it('renders shipped this week only when it is the sole signal', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} shippedThisWeek={5} />,
    );
    expect(html).toContain('5 shipped this week');
  });

  it('omits shipped this week when other signals are present', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} awaitingVerification={1} shippedThisWeek={5} />,
    );
    expect(html).not.toContain('shipped');
    expect(html).toContain('awaiting merge');
  });

  it('renders all three: awaiting, blocked, held when all > 0', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} awaitingVerification={1} blocked={2} held={1} />,
    );
    expect(html).toContain('1 awaiting merge');
    expect(html).toContain('2 blocked');
    expect(html).toContain('1 held');
  });

  it('renders progress percentage', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow {...baseProps} progress={77} />);
    expect(html).toContain('77%');
  });

  it('links to initiative detail page for a real initiative', () => {
    const html = renderToStaticMarkup(<InitiativeTriageRow {...baseProps} id="uuid-1" />);
    expect(html).toContain('/app/initiatives/uuid-1');
  });

  it('links to missions?unassigned=true for the unassigned bucket', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} id="__unassigned__" title="Other" />,
    );
    expect(html).toContain('/app/missions?unassigned=true');
  });

  it('renders title truncated in the link', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} title="My Great Initiative" />,
    );
    expect(html).toContain('My Great Initiative');
  });

  it('renders dismiss button for dormant rows on desktop', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} isDormant onDismiss={() => {}} />,
    );
    expect(html).toContain('Dismiss initiative from triage');
  });

  it('does not render dismiss button for non-dormant rows', () => {
    const html = renderToStaticMarkup(
      <InitiativeTriageRow {...baseProps} isDormant={false} onDismiss={() => {}} />,
    );
    expect(html).not.toContain('Dismiss initiative from triage');
  });
});
