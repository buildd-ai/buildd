import { describe, expect, it } from 'bun:test';
import { hrefWithout } from './url-sheet';

describe('hrefWithout', () => {
  it('drops the keys that opened the sheet and keeps the rest', () => {
    expect(hrefWithout('/app/missions', 'new=1&workspace=ws-1&artifactId=a', ['new', 'artifactId'])).toBe('/app/missions?workspace=ws-1');
  });

  it('returns the bare path when nothing is left', () => {
    expect(hrefWithout('/app/home', '?pr=7&t=tok', ['pr', 't'])).toBe('/app/home');
  });

  it('leaves a URL without the keys alone', () => {
    expect(hrefWithout('/app/settings/team', 'team=t1', ['new'])).toBe('/app/settings/team?team=t1');
  });
});
