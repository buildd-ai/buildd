import { describe, expect, it } from 'bun:test';

/**
 * Settings → Models is one page: Providers (sign-ins, the gateway and the
 * endpoint live in the provider rows), Used for, Tiers, in that order, each with an anchor, and the old anchors from
 * /app/settings/providers, /app/settings/ai and Runners still land.
 */
const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const client = await Bun.file(new URL('../providers/ModelProvidersClient.tsx', import.meta.url)).text();

describe('Settings → Models page', () => {
  it('orders the sections Providers, Used for, Tiers and has no sign-ins or Routing section', () => {
    // "Providers", or "Providers · <team>" for someone in several teams.
    expect(client.indexOf('title={providersTitle(data)}')).toBeGreaterThan(-1);
    expect(client.indexOf('title={providersTitle(data)}')).toBeLessThan(client.indexOf('<UsedForSection'));
    expect(client).not.toContain('title="Routing"');
    const at = (s: string) => page.indexOf(s);
    expect(page).not.toContain('title="Runner sign-ins"');
    expect(page).not.toContain('<AgentBackendsSection');
    expect(page).not.toContain('between=');
    expect(at('title="Tiers"')).toBeGreaterThan(at('<ModelProvidersClient'));
    expect(page).not.toContain('title="Features"');
  });

  it('keeps every anchor a link may point at', () => {
    for (const id of ['tiers', 'features', 'inference-spending']) {
      expect(`${id}: ${page.includes(`id="${id}"`)}`).toBe(`${id}: true`);
    }
    for (const id of ['keys', 'providers', 'provider-keys', 'sign-ins', 'agent-backends', 'advanced', 'routing']) {
      expect(`${id}: ${client.includes(`id="${id}"`)}`).toBe(`${id}: true`);
    }
  });

  it('has no back link and no Tailwind uppercase', () => {
    expect(page).not.toContain('←');
    expect(page).not.toMatch(/\buppercase\b/);
  });

  it('operator controls follow the operator gate, not a team permission; My maximum is on You › Keys', async () => {
    expect(page).toContain('const operator = await isPlatformOperatorCaller({ user })');
    expect(page).toContain('operator={operator}');
    expect(page).not.toMatch(/operator=\{perms\./);
    expect(page).not.toContain('MyMaximumSection');
    const keys = await Bun.file(new URL('../keys/page.tsx', import.meta.url)).text();
    expect(keys).toContain('<MyMaximumSection');
  });

  it('has no decision features, chat retros or goal grading controls', () => {
    for (const gone of ['DecisionFeatures', 'ChatRetroSection', 'isPlatformOperator(', 'ModelFeatures', 'hasTeamInferenceKey']) {
      expect(`${gone}: ${page.includes(gone)}`).toBe(`${gone}: false`);
    }
  });
});
