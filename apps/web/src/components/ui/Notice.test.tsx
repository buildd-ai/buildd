import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Notice from './Notice';

const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`\\n {2}${selector.replace(/[.]/g, '\\.')} +\\{([^}]*)\\}`))?.[1];

describe('Notice', () => {
  it('renders the .notice frame with its tone class, role=status', () => {
    const html = renderToStaticMarkup(<Notice tone="ok">Saved</Notice>);
    expect(html).toMatch(/^<div class="notice notice-ok"[^>]*role="status"/);
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('Saved');
  });

  it('err is role=alert; warn and info are role=status', () => {
    expect(renderToStaticMarkup(<Notice tone="err">Failed</Notice>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Notice tone="warn">Heads up</Notice>)).toContain('role="status"');
    expect(renderToStaticMarkup(<Notice tone="info">FYI</Notice>)).toContain('role="status"');
  });

  it('defaults to the neutral info tone', () => {
    expect(renderToStaticMarkup(<Notice>FYI</Notice>)).toContain('class="notice notice-info"');
  });

  it('title carries a glyph so the tone never reads by colour alone', () => {
    const html = renderToStaticMarkup(<Notice tone="warn" title="Token expires soon">Reconnect before Friday.</Notice>);
    expect(html).toContain('data-testid="notice-title"');
    expect(html).toMatch(/aria-hidden="true"[^>]*>!<\/span>Token expires soon/);
    expect(html).toContain('Reconnect before Friday.');
    expect(renderToStaticMarkup(<Notice tone="err" title="x" />)).toMatch(/aria-hidden="true"[^>]*>✕</);
    expect(renderToStaticMarkup(<Notice tone="ok" title="x" />)).toMatch(/aria-hidden="true"[^>]*>✓</);
  });

  it('one optional action, as a .btn, never a primary fill', () => {
    const link = renderToStaticMarkup(<Notice tone="warn" action={{ label: 'Reconnect', href: '/app/settings' }}>x</Notice>);
    expect(link).toMatch(/<a class="btn btn-sm"[^>]*href="\/app\/settings"[^>]*>Reconnect<\/a>/);
    const button = renderToStaticMarkup(<Notice tone="err" action={{ label: 'Retry', onClick: () => {} }}>x</Notice>);
    expect(button).toMatch(/<button type="button" class="btn btn-sm" data-testid="notice-action">Retry<\/button>/);
    expect(link + button).not.toMatch(/btn-primary|btn-ink|bg-accent|bg-primary/);
  });

  it('no action, no title: just the body', () => {
    const html = renderToStaticMarkup(<Notice tone="ok">Saved</Notice>);
    expect(html).not.toContain('notice-action');
    expect(html).not.toContain('notice-title');
  });
});

describe('.notice classes match Notice', () => {
  it('four tones: ok, warn, err and a neutral info', () => {
    expect(rule('.notice-ok')).toContain('var(--status-success)');
    expect(rule('.notice-warn')).toContain('var(--status-warning)');
    expect(rule('.notice-err')).toContain('var(--status-error)');
    expect(rule('.notice-info')).toContain('var(--border-strong)');
  });

  it('info is never orange', () => {
    expect(rule('.notice-info')).not.toMatch(/accent/);
  });

  it('the frame sits on the card radius', () => {
    expect(rule('.notice')).toContain('border-radius: var(--radius-card);');
  });
});
