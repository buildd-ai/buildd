import { describe, it, expect } from 'bun:test';

/**
 * The shell (team switcher, workspace picker) and Home must resolve the active
 * team the same way. They used to disagree whenever the `buildd-team` cookie
 * was missing or named a team the user had left: the layout defaulted to the
 * first team, Home fell back to cross-team workspaces with an empty filter
 * list, and a user with workspaces was told "This team doesn't have a
 * workspace yet". resolveActiveTeamScope's behaviour is tested in
 * lib/team-access.test.ts; this pins that both surfaces use it and render
 * Home's writes off the render path.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/.*$/gm, '');
}

const layout = code(await Bun.file(new URL('./layout.tsx', import.meta.url)).text());
const home = code(await Bun.file(new URL('./home/page.tsx', import.meta.url)).text());

describe('one active-team resolver for the shell and Home', () => {
  it('layout resolves the team via resolveActiveTeamScope, with no first-team default of its own', () => {
    expect(layout).toContain('resolveActiveTeamScope(');
    expect(layout).not.toMatch(/userTeams\[0\]/);
  });

  it('Home resolves the team via resolveActiveTeamScope, with no cross-team fallback', () => {
    expect(home).toContain('resolveActiveTeamScope(');
    expect(home).not.toContain('getUserWorkspaceIds(');
  });

  it("Home's empty state is decided by rightNowState over the queried workspace set", () => {
    expect(home).toContain('rightNowState(');
    expect(home).not.toMatch(/teamWorkspaces\.length === 0 \?/);
  });
});

describe('the headline counts the same set as the Needs-you stack', () => {
  it('headline, stat strip and stack badge all read needsYouCount, built from the initiative-filtered list', () => {
    expect(home).toContain('homeHeadline({ live, needsYou: needsYouCount');
    expect(home).toContain('needsYou={needsYouCount}');
    expect(home).toContain('count={needsYouCount}');
    expect(home).toMatch(/const queueNeedsYou = needsYouItems\.filter/);
    expect(home).not.toContain('waiting on you`');
  });
});

describe('Home does not await bookkeeping writes during render', () => {
  it('the initiative-progress snapshot upsert goes through recordBestEffort', () => {
    const upsertAt = home.indexOf('.insert(initiativeProgressSeen)');
    expect(upsertAt).toBeGreaterThan(-1);
    const before = home.slice(Math.max(0, upsertAt - 300), upsertAt);
    expect(before).toContain('recordBestEffort(');
    expect(before).not.toMatch(/await\s+db\s*$/);
  });
});
