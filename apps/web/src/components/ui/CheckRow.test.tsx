import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CheckRow, { CHECK_STATE_WORD, CHECK_STATUSES, type CheckRowStatus } from './CheckRow';

const html = (status: CheckRowStatus, over: Partial<Parameters<typeof CheckRow>[0]> = {}) =>
  renderToStaticMarkup(<CheckRow name="Merge into dev" status={status} detail="#5701" href="/pr/5701" {...over} />);

describe('CheckRow (spec 072de598 I-22, AC-29)', () => {
  it('shows the name, a short state word and one mono detail', () => {
    const h = html('review', { detail: '#5701 · changes requested' });
    expect(h).toContain('Merge into dev');
    expect(h).toContain('>Needs review<');
    expect(h).toContain('font-mono');
    expect(h).toContain('#5701 · changes requested');
  });

  it('every status has its own state word and its own icon shape', () => {
    const icons = new Set(CHECK_STATUSES.map(s => /data-icon="([^"]+)"/.exec(html(s))![1]));
    expect(icons.size).toBe(CHECK_STATUSES.length);
    expect(CHECK_STATUSES.map(s => CHECK_STATE_WORD[s])).toEqual(['Passed', 'Running', 'Queued', 'Skipped', 'Failed', 'Needs review']);
  });

  it('the in-review state word is available for a running merge', () => {
    expect(html('running', { stateWord: 'In review' })).toContain('>In review<');
  });

  it('the whole row is one link to its target, with no Open button', () => {
    const h = html('queued');
    expect(h.match(/<a /g)).toHaveLength(1);
    expect(h).toContain('href="/pr/5701"');
    expect(h).not.toMatch(/Open the PR|Open release/);
  });

  it('a row with no target is not a link', () => {
    expect(html('queued', { href: null })).not.toContain('<a ');
  });

  it('an action sits inside the row without nesting in the link', () => {
    const h = html('queued', { action: <button type="button">Skip</button> });
    expect(h).toContain('>Skip<');
    expect(h.match(/<a /g)).toHaveLength(1);
    expect(/<a [^>]*>[^]*?<\/a>/.exec(h)![0]).not.toContain('<button');
  });

  it('marks the current step', () => {
    expect(html('running', { current: true })).toContain('aria-current="step"');
    expect(html('running')).not.toContain('aria-current');
  });
});

describe('CheckRow layout (design UiCheckRow)', () => {
  it('puts the state word after the text, in mono, not beside the name', () => {
    const h = html('running', { stateWord: 'In review' });
    expect(h.indexOf('#5701')).toBeLessThan(h.indexOf('>In review<'));
    expect(/<span class="[^"]*font-mono[^"]*">In review</.test(h)).toBe(true);
  });

  it('marks a desktop step', () => {
    expect(html('queued', { steps: true })).toContain('data-steps="true"');
  });
});
