import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import WaitingLine from './WaitingLine';
import type { WaitingReason } from '@buildd/core/waiting-reason';

function reason(kind: WaitingReason['kind'], label: string): WaitingReason {
  return {
    kind, class: 'hold', strength: 'hard', intent: 'intentional',
    blocker: { label } as WaitingReason['blocker'],
    provenance: { source: 'probe', derivedFrom: 'test' },
    because: 'nobody has approved it',
    releasesWhen: { event: 'access.granted', text: 'a person approves it' },
    action: { owner: 'human', force: null },
  };
}

describe('WaitingLine headline', () => {
  it('access_unmet says the wait is on you', () => {
    const html = renderToStaticMarkup(<WaitingLine reasons={[reason('access_unmet', 'Axiom read')]} />);
    expect(html).toContain('Waiting on you: approve');
    expect(html).toContain('Axiom read');
  });

  it('delegation_unmet says the wait is on you to grant it', () => {
    const html = renderToStaticMarkup(<WaitingLine reasons={[reason('delegation_unmet', 'filing tasks in web')]} />);
    expect(html).toContain('Waiting on you: grant');
    expect(html).toContain('filing tasks in web');
  });

  it('other kinds keep the plain headline', () => {
    const html = renderToStaticMarkup(<WaitingLine reasons={[reason('task_held', 'Another task')]} />);
    expect(html).not.toContain('Waiting on you');
  });
});
