import { describe, expect, it } from 'bun:test';

/**
 * Settings → Models is one page: Keys (sign-ins live in the provider
 * rows), Routing, Tiers, in that order, each with an anchor, and the old anchors from
 * /app/settings/providers, /app/settings/ai and Runners still land.
 */
const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const client = await Bun.file(new URL('../providers/ModelProvidersClient.tsx', import.meta.url)).text();

describe('Settings → Models page', () => {
  it('orders the sections Keys, Routing, Tiers and has no sign-ins section', () => {
    expect(client.indexOf('title="Keys"')).toBeLessThan(client.indexOf('title="Routing"'));
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
    for (const id of ['keys', 'provider-keys', 'sign-ins', 'agent-backends', 'advanced']) {
      expect(`${id}: ${client.includes(`id="${id}"`)}`).toBe(`${id}: true`);
    }
  });

  it('has no back link and no Tailwind uppercase', () => {
    expect(page).not.toContain('←');
    expect(page).not.toMatch(/\buppercase\b/);
  });

  it('has no decision features, chat retros or goal grading controls', () => {
    for (const gone of ['DecisionFeatures', 'ChatRetroSection', 'isPlatformOperator', 'ModelFeatures', 'hasTeamInferenceKey']) {
      expect(`${gone}: ${page.includes(gone)}`).toBe(`${gone}: false`);
    }
  });
});
