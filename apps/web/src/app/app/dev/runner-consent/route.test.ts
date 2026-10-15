/**
 * The runner consent fixture (task 93451838): the Visual QA harness renders
 * the real runner consent page from placeholder teams, never in production,
 * and nothing on it can mint a key or post to a real endpoint.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GET } from './route';
import { FIXTURE_ACTION, RUNNER_CONSENT_FIXTURE_STATES } from './runner-consent-fixtures';

const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;
const originalSecrets = [env.OAUTH_JWT_SECRET, env.AUTH_SECRET, env.NEXTAUTH_SECRET];

afterEach(() => {
  env.NODE_ENV = originalNodeEnv;
  [env.OAUTH_JWT_SECRET, env.AUTH_SECRET, env.NEXTAUTH_SECRET] = originalSecrets;
});

async function page(state?: string) {
  env.NODE_ENV = 'development';
  const url = `http://localhost/app/dev/runner-consent${state ? `?state=${state}` : ''}`;
  const res = await GET(new NextRequest(url));
  return { res, html: await res.text() };
}

function ticked(html: string): string[] {
  return [...html.matchAll(/name="ws" value="([^"]+)"( checked)?/g)].filter((m) => m[2]).map((m) => m[1]);
}
function offered(html: string): string[] {
  return [...html.matchAll(/name="ws" value="([^"]+)"/g)].map((m) => m[1]);
}

describe('production gate', () => {
  it('refuses every state in production', async () => {
    for (const state of [undefined, ...RUNNER_CONSENT_FIXTURE_STATES]) {
      env.NODE_ENV = 'production';
      const res = await GET(new NextRequest(`http://localhost/app/dev/runner-consent${state ? `?state=${state}` : ''}`));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<form');
    }
  });

  it('refuses an unknown state', async () => {
    const { res } = await page('nope');
    expect(res.status).toBe(404);
  });
});

describe('every state', () => {
  it('renders the runner page with no signing secret, posting nowhere real', async () => {
    env.OAUTH_JWT_SECRET = undefined;
    env.AUTH_SECRET = undefined;
    env.NEXTAUTH_SECRET = undefined;
    for (const state of RUNNER_CONSENT_FIXTURE_STATES) {
      const { res, html } = await page(state);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(html).toContain('data-consent="runner"');
      expect(html).toContain(`action="${FIXTURE_ACTION}"`);
      expect(html).not.toContain('action="/api/');
      expect(html).toContain('name="csrf_token" value="fixture"');
    }
  });

  it('never imports the database or key minting', () => {
    const src = readFileSync(join(import.meta.dir, 'runner-consent-fixtures.ts'), 'utf8')
      + readFileSync(join(import.meta.dir, 'route.ts'), 'utf8');
    expect(src).not.toMatch(/from '@\/lib\/runner-picks'/);
    expect(src).not.toMatch(/@buildd\/core\/db/);
    expect(src).not.toMatch(/@\/auth'/);
  });
});

describe('scripts/qa/plans/runner-consent.json', () => {
  it('captures every state', () => {
    const plan = JSON.parse(readFileSync(join(import.meta.dir, '../../../../../../../scripts/qa/plans/runner-consent.json'), 'utf8')) as Array<{ route: string }>;
    expect(plan.map((p) => p.route)).toEqual(RUNNER_CONSENT_FIXTURE_STATES.map((s) => `/app/dev/runner-consent?state=${s}`));
  });
});

describe('cli (default)', () => {
  it('lists every team, a restricted workspace only where the person is an admin, and the long name', async () => {
    const { html } = await page();
    expect(html).toContain('<h1>Connect a runner</h1>');
    for (const team of ['Northwind Studio', 'Harbor Labs', 'Side projects']) expect(html).toContain(team);
    const ids = offered(html);
    expect(ids).toContain('nw-billing'); // restricted, admin
    expect(ids).not.toContain('hb-infra'); // restricted, member
    expect(ids).not.toContain('nw-coord'); // internal
    expect(ids).toContain('nw-long');
    expect(html).toContain('customer-onboarding-experience-redesign-and-migration');
    expect(html).toContain('127.0.0.1:41776');
    expect(ticked(html)).toEqual([]);
    expect(html).not.toContain('Choose at least one workspace.');
  });
});

describe('single', () => {
  it('ticks the only workspace', async () => {
    const { html } = await page('single');
    expect(offered(html)).toEqual(['solo-notes']);
    expect(ticked(html)).toEqual(['solo-notes']);
  });
});

describe('device', () => {
  it('names the device code', async () => {
    const { html } = await page('device');
    expect(html).toContain('WDJB-MJHT');
    expect(html).toContain('name="code" value="WDJB-MJHT"');
  });
});

describe('edit', () => {
  it('starts from current picks, drops the removed and unreachable ones, and says who removed what', async () => {
    const { html } = await page('edit');
    expect(html).toContain('<h1>Change runner workspaces</h1>');
    expect(html).toContain('A team admin removed it from legacy-api.');
    expect(offered(html)).not.toContain('nw-legacy');
    expect(offered(html)).not.toContain('gone-reports');
    expect(ticked(html).sort()).toEqual(['hb-mobile', 'nw-api', 'nw-web']);
  });
});

describe('error', () => {
  it('shows the nothing-ticked error', async () => {
    const { html } = await page('error');
    expect(html).toContain('Choose at least one workspace.');
    expect(ticked(html)).toEqual([]);
  });
});
