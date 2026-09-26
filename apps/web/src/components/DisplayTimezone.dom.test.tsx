/**
 * ZonedTime hydrating in a browser (happy-dom). The process zone stands in for
 * the viewer's device zone. Runs in its own process (scripts/run-unit-tests.ts),
 * so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterAll, describe, expect, it } from 'bun:test';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { DisplayTimezoneProvider, ZonedTime } from './DisplayTimezone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EVALUATED_AT = '2026-09-24T11:55:46.000Z';
const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

async function hydrate(tree: React.ReactElement, serverTz: string, browserTz: string) {
  process.env.TZ = serverTz;
  const container = document.createElement('div');
  container.innerHTML = renderToString(tree);
  document.body.appendChild(container);
  const errors: unknown[] = [];
  process.env.TZ = browserTz;
  await act(async () => {
    hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(e) });
  });
  return { text: container.textContent, errors };
}

describe('ZonedTime hydration', () => {
  it('team zone: server (UTC) and browser (Auckland) agree on the team-zone string', async () => {
    const { text, errors } = await hydrate(
      <DisplayTimezoneProvider teamTimezone="America/New_York">
        <ZonedTime value={EVALUATED_AT} />
      </DisplayTimezoneProvider>,
      'UTC',
      'Pacific/Auckland',
    );
    expect(errors).toEqual([]);
    expect(text).toBe('Sep 24, 2026, 7:55:46 AM EDT');
  });

  it('no team zone: falls back to the browser zone after mount, not the server zone', async () => {
    const { text, errors } = await hydrate(
      <DisplayTimezoneProvider teamTimezone={null}>
        <ZonedTime value={EVALUATED_AT} />
      </DisplayTimezoneProvider>,
      'UTC',
      'Pacific/Auckland',
    );
    expect(errors).toEqual([]);
    expect(text).toBe('Sep 24, 2026, 11:55:46 PM GMT+12');
  });
});
