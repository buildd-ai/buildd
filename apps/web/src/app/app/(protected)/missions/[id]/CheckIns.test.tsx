/**
 * Check-ins copy on the mission detail page
 * (docs/design/event-driven-mission-replanning.md §5): users read
 * "check-in", "organizer run" and "organizer checklist", never "heartbeat".
 */
import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/missions/m-1',
  useSearchParams: () => new URLSearchParams(''),
}));

import HeartbeatStatusBadge from './HeartbeatStatusBadge';
import HeartbeatTimeline from './HeartbeatTimeline';
import HeartbeatChecklistEditor from './HeartbeatChecklistEditor';
import QuietHoursConfig from './QuietHoursConfig';

describe('Last check badge', () => {
  it('renders the last check label', () => {
    const html = renderToStaticMarkup(
      <HeartbeatStatusBadge check={{ label: 'stuck, organizer started', tone: 'warning', at: null }} />,
    );
    expect(html).toContain('stuck, organizer started');
    expect(html).not.toMatch(/heartbeat/i);
  });
});

describe('Organizer runs timeline', () => {
  it('is titled Organizer runs, with the run count', () => {
    const html = renderToStaticMarkup(
      <HeartbeatTimeline
        runs={[
          { id: 't1', createdAt: new Date().toISOString(), status: 'completed', triggerSource: 'event', triggerLabel: 'after work finished', result: null },
          { id: 't2', createdAt: new Date().toISOString(), status: 'completed', triggerSource: 'backstop', triggerLabel: 'stuck check', result: null },
        ]}
      />,
    );
    expect(html).toContain('Organizer runs');
    expect(html).toContain('(2)');
    expect(html).not.toContain('Evaluation Log');
    expect(html).not.toMatch(/Heartbeat/);
  });

  it('renders nothing with no runs', () => {
    expect(renderToStaticMarkup(<HeartbeatTimeline runs={[]} />)).toBe('');
  });
});

describe('Organizer checklist editor', () => {
  it('is titled Organizer checklist and says when it is followed', () => {
    const html = renderToStaticMarkup(<HeartbeatChecklistEditor missionId="m-1" checklist={null} />);
    expect(html).toContain('Organizer checklist');
    expect(html).toContain('What the organizer follows each time it plans the next step.');
    expect(html).not.toMatch(/heartbeat/i);
  });
});

describe('Quiet hours', () => {
  it('says quiet hours pause the check-ins, not the mission', () => {
    const html = renderToStaticMarkup(
      <QuietHoursConfig missionId="m-1" activeHoursStart={null} activeHoursEnd={null} activeHoursTimezone={null} />,
    );
    expect(html).toContain('Check-ins pause during these hours.');
    expect(html).not.toContain('The mission pauses during these hours.');
  });
});
