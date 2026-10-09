import { describe, expect, it } from 'bun:test';

/**
 * Settings → Models is one page: Keys, Runner sign-ins, Routing, Tiers,
 * Features, in that order, each with an anchor, and the old anchors from
 * /app/settings/providers, /app/settings/ai and Runners still land.
 */
const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const client = await Bun.file(new URL('../providers/ModelProvidersClient.tsx', import.meta.url)).text();

describe('Settings → Models page', () => {
  it('orders the sections Keys, sign-ins, Routing, Tiers, Features', () => {
    // Keys and Routing render inside ModelProvidersClient around the `between` slot.
    expect(client.indexOf('title="Keys"')).toBeLessThan(client.indexOf('{between}'));
    expect(client.indexOf('{between}')).toBeLessThan(client.indexOf('title="Routing"'));
    const at = (s: string) => page.indexOf(s);
    expect(at('title="Runner sign-ins"')).toBeGreaterThan(at('<ModelProvidersClient'));
    expect(at('title="Tiers"')).toBeGreaterThan(at('title="Runner sign-ins"'));
    expect(at('title="Features"')).toBeGreaterThan(at('title="Tiers"'));
  });

  it('keeps every anchor a link may point at', () => {
    for (const id of ['sign-ins', 'agent-backends', 'tiers', 'features', 'inference-spending']) {
      expect(`${id}: ${page.includes(`id="${id}"`)}`).toBe(`${id}: true`);
    }
    for (const id of ['keys', 'provider-keys', 'advanced']) {
      expect(`${id}: ${client.includes(`id="${id}"`)}`).toBe(`${id}: true`);
    }
  });

  it('has no back link and no Tailwind uppercase', () => {
    expect(page).not.toContain('←');
    expect(page).not.toMatch(/\buppercase\b/);
  });
});
