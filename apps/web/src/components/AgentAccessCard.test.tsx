import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAccessSection } from './AgentAccessCard';
import type { AgentAccessReport } from '@/lib/agent-capabilities/access-log';

const base: AgentAccessReport = { windowHours: 24, granted: 12, adminGranted: 0, grantProblems: [], refusals: [], healthy: true };
const render = (r: AgentAccessReport | null) => renderToStaticMarkup(<AgentAccessSection report={r} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const problem = { workspaceId: 'w', workspaceName: 'docs', reason: 'the GitHub App installation is suspended', fix: 'Unsuspend the GitHub App installation for this repo.', count: 3, lastAt: '2026-10-05T12:00:00.000Z' };

describe('AgentAccessSection', () => {
  it('renders nothing without a report', () => {
    expect(render(null)).toBe('');
  });

  it('renders nothing on a quiet day: no all-clear sentence, no granted counts', () => {
    expect(render(base)).toBe('');
    expect(render({ ...base, granted: 500, adminGranted: 3 })).toBe('');
  });

  it('names the workspace, the cause and the fix for an access problem', () => {
    const html = render({ ...base, healthy: false, grantProblems: [problem] });
    expect(html).toContain('data-testid="agent-access-problems"');
    expect(text(html)).toContain('Access problems');
    expect(text(html)).toContain('docs: the GitHub App installation is suspended');
    expect(text(html)).toContain('Unsuspend the GitHub App installation');
    expect(text(html)).toContain('3×');
  });

  it('lists blocked actions by action and reason, in plain words, without granted counts', () => {
    const html = render({ ...base, refusals: [{ label: 'Merge PR', reason: "not this task's PR", count: 4 }] });
    expect(text(html)).toContain('Blocked actions');
    expect(text(html)).toContain("Merge PR · not this task's PR");
    expect(html).not.toContain('agent-access-problems');
    expect(text(html)).not.toContain('Access granted');
    expect(html).not.toMatch(/pr_not_owned|github_repo:/);
  });
});
