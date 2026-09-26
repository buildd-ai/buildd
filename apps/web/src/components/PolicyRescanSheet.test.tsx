import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffPolicyConfig } from '@/lib/workspace-health';
import { PolicyDiffList } from './PolicyRescanSheet';

const render = (...args: Parameters<typeof diffPolicyConfig>) =>
  renderToStaticMarkup(<PolicyDiffList diff={diffPolicyConfig(...args)} />);

describe('PolicyDiffList (Re-scan repo diff)', () => {
  it('renders added and removed paths per class', () => {
    const html = render(
      { preset: 'balanced', riskClasses: [{ name: 'ci_deploy_config', detectedPaths: ['.github/workflows/', 'Dockerfile'] }] },
      { preset: 'balanced', riskClasses: [{ name: 'ci_deploy_config', detectedPaths: ['.github/workflows/', 'vercel.json'] }] },
    );
    const row = html.slice(html.indexOf('data-testid="policy-diff-ci_deploy_config"'));
    expect(row).toContain('CI and deploy config');
    expect(row).toMatch(/data-diff="added"[^>]*>.*?vercel\.json/);
    expect(row).toMatch(/data-diff="removed"[^>]*>.*?Dockerfile/);
    expect(row).toMatch(/data-diff="unchanged"[^>]*>.*?\.github\/workflows\//);
    expect(html).not.toContain('policy-diff-unchanged');
  });

  it('renders a class that disappears with its paths as removed', () => {
    const html = render(
      { preset: 'balanced', riskClasses: [{ name: 'public_api_contract', detectedPaths: ['openapi.yaml'] }] },
      { preset: 'balanced', riskClasses: [] },
    );
    expect(html).toContain('data-testid="policy-diff-public_api_contract"');
    expect(html).toMatch(/data-diff="removed"[^>]*>.*?openapi\.yaml/);
  });

  it('says so when nothing changed', () => {
    const cfg = { preset: 'balanced' as const, riskClasses: [{ name: 'dependency_bump' as const, detectedPaths: ['package.json'] }] };
    const html = render(cfg, structuredClone(cfg));
    expect(html).toContain('data-testid="policy-diff-unchanged"');
    expect(html).not.toContain('data-diff="added"');
    expect(html).not.toContain('data-diff="removed"');
  });

  it('shows a preset change', () => {
    const html = render({ preset: 'cautious', riskClasses: [] }, { preset: 'balanced', riskClasses: [] });
    expect(html).toMatch(/Preset changes from .*cautious.* to .*balanced/);
  });
});
