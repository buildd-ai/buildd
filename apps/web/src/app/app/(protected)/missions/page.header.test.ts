import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The Missions header: a sans h1 hidden below md, one small `.btn` "+ New",
 * and the doors to Releases and Initiatives, which left the primary nav and
 * are reached from here. No chat nudge, no orange 2px create button. The page
 * is an async server component with DB reads, so this pins the markup at the
 * source level.
 */
const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('missions page header', () => {
  it('mission plan link requires calibration as well as team availability', () => {
    expect(src).toContain('taskEstimatesDefaultOn() && await taskEstimatesEnabled(activeTeamId)');
    expect(src).toContain('{planEnabled && (');
  });

  it('the h1 is a sans title, hidden visually below md', () => {
    const h1 = src.match(/<h1[^>]*data-testid="missions-headline"[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only md:not-sr-only');
    expect(h1).not.toContain('font-mono');
  });

  it('links to the specs from the header (they have no nav item)', () => {
    expect(src).toMatch(/<Link[^>]*href="\/app\/specs"[^>]*data-testid="missions-specs-link"/);
  });

  it('links to Releases from the header, and no longer to Initiatives', () => {
    expect(src).toMatch(/<Link[^>]*href="\/app\/releases"[^>]*data-testid="missions-releases-link"/);
    expect(src).not.toContain('/app/initiatives');
  });

  it('hands the group filter the mission initiative link and the ?group= param', () => {
    // Each row's group is its initiative, read by the list's loader (lib/mission-list-load.ts).
    const loader = readFileSync(join(import.meta.dir, '../../../../lib/mission-list-load.ts'), 'utf8');
    expect(loader).toContain('groupId: missions.initiativeId');
    expect(src).toMatch(/initialGroup=\{/);
  });

  it('the create entry is a small .btn, not an orange 2px frame', () => {
    const link = src.match(/<NewWorkLink[^>]*testId="new-mission-link"[\s\S]*?>/)?.[0] ?? '';
    expect(link).toMatch(/className="btn\b/);
    // The phone copy in the top bar is the same small .btn.
    expect(readFileSync(join(import.meta.dir, '../../../../components/MobileTopBar.tsx'), 'utf8'))
      .toMatch(/MOBILE_TOP_BAR_ACTION_CLASS = 'btn\b/);
    expect(src).not.toMatch(/bg-prim[a]ry/);
    expect(src).not.toContain('border-2');
  });

  it('phones get no button row under the bar: + New rides in the top bar, the doors on the stats line', () => {
    // The desktop cluster is md-only; the row around it holds only the sr-only h1 on a phone.
    expect(src).toMatch(/<div className="ml-auto hidden flex-wrap items-center gap-3 md:flex">/);
    expect(src).toMatch(/<MobileTopBarAction>\s*<NewWorkLink[\s\S]*?testId="new-mission-link-mobile"/);
    expect(src).toContain('className={MOBILE_TOP_BAR_ACTION_CLASS}');
    expect(src).toContain('doors={doors}');
    expect(src).toMatch(/data-testid="missions-doors-mobile"[\s\S]*href="\/app\/specs"[\s\S]*href="\/app\/releases"/);
  });

  it('clears the top bar with its own gap: the list no longer starts flush under it', () => {
    expect(src).toContain('pt-[4.5rem] md:pt-8');
  });

  it('no chat setup nudge and no team label kicker on Missions', () => {
    expect(src).not.toContain('SetUpChatNudge');
    expect(src).not.toContain('section-label');
  });

  it('loads no release footers and no workspace list: neither renders here any more', () => {
    expect(src).not.toContain('loadReleaseFooterData');
    expect(src).not.toMatch(/workspaces=\{/);
  });

  it('empty states are plain sentences, not centred cards', () => {
    expect(src).not.toMatch(/className="card\b/);
  });
});
