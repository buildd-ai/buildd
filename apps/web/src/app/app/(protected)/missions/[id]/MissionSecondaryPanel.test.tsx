/**
 * MissionSecondaryPanel as the mission page's Settings footer row
 * (docs/design/mission-feed-mobile-continuity.md, W3 footer rows): it matches
 * the Orchestrator, Records and Notes rows and is a 44px tap target.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionSecondaryPanel from './MissionSecondaryPanel';

describe('MissionSecondaryPanel', () => {
  it('renders the row variant as a footer row with a 44px toggle', () => {
    const html = renderToStaticMarkup(
      <MissionSecondaryPanel variant="row" configSummary="daily">
        <div>settings body</div>
      </MissionSecondaryPanel>,
    );
    const toggle = html.match(/<button[^>]*data-testid="mission-settings-row"[^>]*>/);
    expect(toggle).not.toBeNull();
    expect(toggle![0]).toContain('min-h-11');
    expect(toggle![0]).toContain('border-t border-border-default');
    expect(toggle![0]).toContain('aria-expanded="false"');
    expect(html).toContain('Settings');
    expect(html).toContain('daily');
    expect(html).not.toContain('settings body');
  });

  it('keeps the default panel look for other callers', () => {
    const html = renderToStaticMarkup(
      <MissionSecondaryPanel>
        <div>settings body</div>
      </MissionSecondaryPanel>,
    );
    expect(html).not.toContain('data-testid="mission-settings-row"');
    expect(html).toContain('Schedule, configuration &amp; more');
  });
});
