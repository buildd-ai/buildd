import { describe, it, expect } from 'bun:test';

/**
 * Type-scale and colour floor for the Waiting-on-You cards and Home.
 *
 * `text-primary` is the brand orange (#f4811f): about 2.2:1 on the light card,
 * so action links in that colour were unreadable in daylight. `text-accent-text`
 * is the same hue darkened for text in light mode and lightened in dark
 * (globals.css), so it is the token for orange TEXT. Backgrounds (`bg-primary`)
 * and `text-text-primary` (the body colour) are unaffected.
 *
 * Nothing on these surfaces renders below 11px.
 */
const FILES = [
  './WaitingOnYouDecideCard.tsx',
  './WaitingOnYouDiscrepancyCard.tsx',
  './WaitingOnYouMergeCard.tsx',
  './WaitingOnYouReviewCard.tsx',
  './AgentHandledCard.tsx',
  '../app/app/(protected)/home/page.tsx',
  '../app/app/(protected)/home/HomeMissions.tsx',
];

const sources = await Promise.all(
  FILES.map(async (rel) => [rel, await Bun.file(new URL(rel, import.meta.url)).text()] as const),
);

describe('Waiting-on-You and Home text tokens', () => {
  for (const [rel, src] of sources) {
    it(`${rel} uses text-accent-text, never text-primary, for orange text`, () => {
      const hits = src.match(/(?<![-\w])text-primary(?![-\w])/g) ?? [];
      expect(hits).toEqual([]);
    });

    it(`${rel} has no text below 11px`, () => {
      const hits = src.match(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]/g) ?? [];
      expect(hits).toEqual([]);
    });
  }
});
