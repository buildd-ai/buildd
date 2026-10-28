import { describe, expect, it } from 'bun:test';
import { carriedFindingsLines, carriedFixTitles } from './visual-review-carry';

const f = (route: string, viewport: 'mobile' | 'desktop', finding: string) => ({ route, viewport, variant: null, artifactId: `${route}-${viewport}`, finding });

describe('carried findings', () => {
  it('one fix per route, both viewports share it', () => {
    const t = carriedFixTitles([f('/a', 'mobile', 'Header clipped'), f('/a', 'desktop', ''), f('/b', 'desktop', 'Text overlaps')]);
    expect(t.map(x => x.title)).toEqual(['[surface fix] /a: Header clipped', '[surface fix] /b: Text overlaps']);
    expect(t[0].findings).toHaveLength(2);
  });

  it('the completion record lists each screen, and says when one is not filed', () => {
    expect(carriedFindingsLines([])).toEqual([]);
    expect(carriedFindingsLines([{ route: '/a', title: 't', taskId: 'x' }, { route: '/b', title: 't', taskId: null }])).toEqual([
      'Open on the visual review: 2 screens, shipped with the mission and filed as fix tasks on trunk',
      '- /a',
      '- /b (not filed yet)',
    ]);
  });
});
