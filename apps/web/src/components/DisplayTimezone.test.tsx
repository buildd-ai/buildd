import { afterAll, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisplayTimezoneProvider, ZonedTime } from './DisplayTimezone';
import { LoopHistory } from './LoopStatus';

// Server render (what Vercel sends): with a team zone the stamp must follow it
// whatever the process zone is; without one it must NOT show the server's zone.
const EVALUATED_AT = '2026-09-24T11:55:46.000Z';
// Visible text only — the machine-readable dateTime attribute is ISO/UTC by design.
const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ');
const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

for (const processTz of ['UTC', 'Pacific/Auckland']) {
  describe(`server render under TZ=${processTz}`, () => {
    it('renders ZonedTime in the team zone', () => {
      process.env.TZ = processTz;
      const html = renderToStaticMarkup(
        <DisplayTimezoneProvider teamTimezone="America/New_York">
          <ZonedTime value={EVALUATED_AT} />
        </DisplayTimezoneProvider>,
      );
      expect(html).toContain('Sep 24, 2026, 7:55:46 AM EDT');
      expect(html).toContain('dateTime="2026-09-24T11:55:46.000Z"');
    });

    it('renders the loop history iteration stamp in the team zone', () => {
      process.env.TZ = processTz;
      const html = renderToStaticMarkup(
        <DisplayTimezoneProvider teamTimezone="America/New_York">
          <LoopHistory
            loopState="condition_unmet"
            maxLoops={3}
            entries={[{
              iteration: 0,
              workerId: 'worker-1',
              evaluatedAt: EVALUATED_AT,
              conditionType: 'command',
              satisfied: false,
              summary: 'Command failed',
            }]}
          />
        </DisplayTimezoneProvider>,
      );
      expect(html).toContain('Iteration 1');
      expect(html).toContain('Sep 24, 2026, 7:55:46 AM EDT');
      expect(visibleText(html)).not.toContain('11:55:46');
      expect(visibleText(html)).not.toContain('9/24/2026');
    });

    it('with no team zone, renders the fallback — never the server zone', () => {
      process.env.TZ = processTz;
      const html = renderToStaticMarkup(<ZonedTime value={EVALUATED_AT} fallback="—" />);
      expect(html).toContain('>—</time>');
      expect(visibleText(html)).not.toContain('11:55');
      expect(visibleText(html)).not.toContain('Sep 24');
    });
  });
}
