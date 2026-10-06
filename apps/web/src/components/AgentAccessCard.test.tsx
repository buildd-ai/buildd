import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAccessSection } from './AgentAccessCard';
import type { AgentAccessReport } from '@/lib/agent-capabilities/access-log';

const base: AgentAccessReport = { windowHours: 24, granted: 12, adminGranted: 0, grantProblems: [], refusals: [], healthy: true };
const render = (r: AgentAccessReport | null) => renderToStaticMarkup(<AgentAccessSection report={r} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('AgentAccessSection', () => {
  it('renders nothing without a report', () => {
    expect(render(null)).toBe('');
  });

  it('is one line on a quiet day', () => {
    const html = render(base);
    expect(text(html)).toContain('no agent reached outside its task');
    expect(html).not.toContain('agent-access-refusals');
    expect(html).not.toContain('Refused actions');
  });

  it('names the workspace, the cause and the fix for a grant problem', () => {
    const html = render({ ...base, healthy: false, grantProblems: [{ workspaceId: 'w', workspaceName: 'docs', reason: 'the GitHub App installation is suspended', fix: 'Unsuspend the GitHub App installation for this repo.', count: 3, lastAt: '2026-10-05T12:00:00.000Z' }] });
    expect(html).toContain('data-healthy="false"');
    expect(text(html)).toContain('docs: the GitHub App installation is suspended');
    expect(text(html)).toContain('Unsuspend the GitHub App installation');
  });

  it('lists refusals by action and reason, in plain words', () => {
    const html = render({ ...base, refusals: [{ label: 'Merge PR', reason: "not this task's PR", count: 4 }] });
    expect(text(html)).toContain('refused 4 actions outside their task');
    expect(text(html)).toContain("Merge PR · not this task's PR");
    expect(html).not.toMatch(/pr_not_owned|github_repo:/);
  });
});
