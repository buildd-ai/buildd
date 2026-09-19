/**
 * What this panel is allowed to offer.
 *
 * Everything in it is a CAPABILITY — Plan now, Disarm, Edit schedule, Complete,
 * Delete. None of them is ever the answer to "what is being asked of me", and
 * the mission this suite exists for rendered all of them at equal weight with
 * no statement of what the mission was waiting on.
 *
 * Two rules, pinned here:
 *  - capabilities live behind a disclosure, not in a row;
 *  - when the header already offers the one action that advances the mission,
 *    this panel raises no primary button of its own.
 */
import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  CHANNEL_PREFIX: 'test-',
}));

const { default: MissionSettings } = await import('./MissionSettings');

function render(overrides: Partial<Parameters<typeof MissionSettings>[0]> = {}) {
  return renderToStaticMarkup(
    <MissionSettings
      missionId="m-1"
      currentStatus="active"
      cronExpression={null}
      workspaceId="ws-1"
      roles={[]}
      hasSchedule={false}
      orchestrationMode="auto"
      isHeld={false}
      displayState="review"
      {...overrides}
    />,
  );
}

/** The one primary-button class in this panel. */
const PRIMARY = 'bg-accent text-white';

describe('capabilities live behind a disclosure', () => {
  it('puts Disarm, Edit schedule, Complete, Delete and Plan now inside the overflow menu', () => {
    const html = render({ displayState: 'active' });

    expect(html).toContain('data-testid="mission-capability-menu"');
    // Everything below the summary is inside the <details> element.
    const menu = html.slice(html.indexOf('data-testid="mission-capability-menu"'));
    for (const capability of ['Plan now', 'Disarm', 'Add schedule', 'Complete', 'Delete']) {
      expect(menu).toContain(capability);
    }
    expect(html).toContain('More actions');
  });

  it('renders no capability menu for a terminal mission', () => {
    expect(render({ currentStatus: 'completed' })).not.toContain('data-testid="mission-capability-menu"');
  });
});

describe('the header owns the primary action', () => {
  it('offers Complete mission as primary when the header has no suggestion', () => {
    const html = render({ displayState: 'review', hasPrimaryAction: false });

    expect(html).toContain('Complete mission');
    expect(html).toContain(PRIMARY);
  });

  it('raises no primary button when the header is already offering one', () => {
    // The observed screen: the mission PR was the thing to do, and this panel
    // put "Complete mission" at the same weight one row below it.
    const html = render({ displayState: 'review', hasPrimaryAction: true });

    expect(html).not.toContain('Complete mission');
    expect(html).not.toContain(PRIMARY);
  });

  it('still shows Arm mission as primary for a held mission, since no header affordance exists for it', () => {
    const html = render({ isHeld: true, displayState: 'active', hasPrimaryAction: false });

    expect(html).toContain('Arm mission');
    expect(html).toContain(PRIMARY);
  });
});
