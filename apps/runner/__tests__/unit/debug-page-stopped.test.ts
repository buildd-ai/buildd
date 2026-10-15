/**
 * The local debug page says plainly that its runner has stopped once the
 * runner stops answering, instead of "reconnecting..." forever, and its claim
 * rows show the server-side words (spec c7410e76 R-28, AC-13).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const html = readFileSync(join(import.meta.dir, '..', '..', 'ui-debug', 'debug.html'), 'utf8');

function loadConnectionView(): (sinceMs: number | null) => { label: string; stopped: boolean; detail: string } {
  const m = html.match(/\/\/ <connection-view>([\s\S]*?)\/\/ <\/connection-view>/);
  if (!m) throw new Error('connection-view block missing from debug.html');
  return new Function(`${m[1]}; return connectionView;`)();
}

describe('debug page connection view', () => {
  const view = loadConnectionView();

  test('connected: no message', () => {
    expect(view(null)).toEqual({ label: 'connected', stopped: false, detail: '' });
  });

  test('a brief outage still says reconnecting', () => {
    const v = view(5_000);
    expect(v.label).toBe('reconnecting...');
    expect(v.stopped).toBe(false);
  });

  test('a long outage says the runner has stopped and points at buildd top', () => {
    const v = view(60_000);
    expect(v.stopped).toBe(true);
    expect(v.label).toBe('runner stopped');
    expect(v.detail).toContain('This runner has stopped');
    expect(v.detail).toContain('background service');
    expect(v.detail).toContain('buildd top');
    expect(v.detail).not.toContain('reconnecting');
  });
});

describe('debug page claim rows', () => {
  test('rows use the words the runner sends, never the bare event name', () => {
    expect(html).toContain('e.words');
    expect(html).not.toMatch(/e\.diagnosticReason \|\| e\.event/);
  });
});
