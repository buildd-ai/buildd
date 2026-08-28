import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamSwitcher } from './TeamSwitcher';

const TEAMS = [
  { id: 't1', name: 'Cue', slug: 'cue' },
  { id: 't2', name: 'Buildd', slug: 'buildd' },
];

describe('TeamSwitcher', () => {
  it('renders the active team name as the switch affordance (turbopuffer/Vercel pattern)', () => {
    const html = renderToStaticMarkup(<TeamSwitcher teams={TEAMS} currentTeamId="t1" />);
    // The name must live inside the button — a bare chevron is not a discoverable
    // affordance on mobile (regression from #1821's `hidden sm:inline`).
    const button = html.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('Cue');
  });

  it('never hides the team name at narrow widths', () => {
    const html = renderToStaticMarkup(<TeamSwitcher teams={TEAMS} currentTeamId="t1" />);
    expect(html).not.toContain('hidden sm:inline');
  });

  it('truncates instead of overflowing at 320pt', () => {
    const long = [{ id: 't1', name: 'An Extremely Long Team Name Indeed', slug: 'x' }, TEAMS[1]];
    const html = renderToStaticMarkup(<TeamSwitcher teams={long} currentTeamId="t1" />);
    expect(html).toContain('truncate');
    expect(html).toMatch(/max-w-\[\d+px\]/);
  });

  it('shows a single team as plain visible text with no dropdown', () => {
    const html = renderToStaticMarkup(<TeamSwitcher teams={[TEAMS[0]]} currentTeamId="t1" />);
    expect(html).toContain('Cue');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('hidden');
  });

  it('falls back to the first team when currentTeamId is unknown', () => {
    const html = renderToStaticMarkup(<TeamSwitcher teams={TEAMS} currentTeamId={null} />);
    expect(html).toContain('Cue');
  });

  it('renders nothing without teams', () => {
    expect(renderToStaticMarkup(<TeamSwitcher teams={[]} currentTeamId={null} />)).toBe('');
  });
});
