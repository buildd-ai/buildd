import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolsMenu as KitToolsMenu, ToolRows } from '@builddai/ai-kit/chat/react';
import ToolsMenu from './ToolsMenu';
import { TierDetail } from './TierSwitch';

const rows = [
  { key: 'tasks', label: 'Tasks', mode: 'allow' as const, locked: false },
  { key: 'admin', label: 'Admin', mode: 'ask' as const, locked: true },
  { key: 'secrets', label: 'Secrets', mode: 'never' as const, locked: true },
];

describe('tools cell', () => {
  it('is the kit menu in a composer cell, the trigger just the dots', () => {
    const html = renderToStaticMarkup(<ToolsMenu teamId="t1" />);
    expect(html).toContain('data-testid="composer-tools"');
    expect(html).toContain('buildd-menu-cell');
    const trigger = html.slice(html.indexOf('data-testid="kit-tools-trigger"'), html.indexOf('</button>'));
    expect(trigger.replace(/<[^>]*>/g, '').replace(/^[^>]*>/, '')).toBe('···');
  });

  it('never shows an Allow count, even with a group allowed', () => {
    const html = renderToStaticMarkup(<KitToolsMenu rows={rows} onChange={() => {}} />);
    const trigger = html.slice(html.indexOf('data-testid="kit-tools-trigger"'), html.indexOf('</button>'));
    expect(trigger).not.toMatch(/\d/);
    expect(html).toContain('aria-label="Tools"');
  });
});

describe('ToolRows (the kit\'s, as buildd shows them)', () => {
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
