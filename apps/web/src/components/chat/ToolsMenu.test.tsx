import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolRows } from './ToolsMenu';
import { TierDetail } from './TierSwitch';

describe('ToolRows', () => {
  const rows = [
    { key: 'tasks', label: 'Tasks', mode: 'allow' as const, locked: false },
    { key: 'admin', label: 'Admin', mode: 'ask' as const, locked: true },
    { key: 'secrets', label: 'Secrets', mode: 'never' as const, locked: true },
  ];

  it('switchable rows get Ask first / Allow with the current one pressed; locked rows get a label only', () => {
    const html = renderToStaticMarkup(<ToolRows rows={rows} onChange={() => {}} />);
    expect(html).toMatch(/data-group="tasks"[\s\S]*aria-pressed="true"[^>]*>Allow</);
    const admin = html.slice(html.indexOf('data-group="admin"'), html.indexOf('data-group="secrets"'));
    expect(admin).not.toContain('<button');
    expect(admin).toContain('Ask first');
    expect(html).toContain('Never');
  });
});

describe('TierDetail', () => {
  it('model, per-1k price and the running cost', () => {
    const html = renderToStaticMarkup(<TierDetail info={{ tier: 'standard', model: 'm-mid', models: ['m-mid'], inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 }} cost={0.0421} />);
    expect(html).toContain('m-mid');
    expect(html).toContain('$0.003 in · $0.015 out');
    expect(html).toContain('$0.04');
  });

  it('a pooled tier names the incumbent and how many more', () => {
    const html = renderToStaticMarkup(<TierDetail info={{ tier: 'budget', model: 'a', models: ['a', 'b', 'c'], inputPer1kUsd: 0.001, outputPer1kUsd: 0.005 }} cost={null} />);
    expect(html).toContain('a +2');
    expect(html).toContain('$0');
  });
});
