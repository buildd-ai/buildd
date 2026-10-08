'use client';

/**
 * `?state=agent-access`: the task page's Access section and Health's Agent
 * access card in each state. Real rows are wiped from the scrubbed QA clone
 * (they name repos and PRs), so route screenshots show neither; these do.
 */
import type { ReactNode } from 'react';
import { DisplayTimezoneProvider } from '@/components/DisplayTimezone';
import TaskAccessSection from '../../(protected)/tasks/[id]/TaskAccessSection';
import { AgentAccessSection } from '@/components/AgentAccessCard';
import type { AccessItem, AgentAccessReport } from '@/lib/agent-capabilities/access-log';

const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 5, h, m)).toISOString();
const item = (o: Partial<AccessItem>): AccessItem => ({
  at: at(16, 3), lastAt: at(16, 3), count: 1, capability: 'github.repo_grant', label: 'GitHub repo access',
  decision: 'allowed', reason: null, target: 'acme/widget', expiresAt: null, workerId: 'w-1', ...o,
});

const WITH_REFUSALS: AccessItem[] = [
  item({ count: 3, lastAt: at(18, 3), expiresAt: at(19, 3) }),
  item({ at: at(16, 3), capability: 'task_token.mint', label: 'buildd token', target: 'worker level', expiresAt: at(23, 59) }),
  item({ at: at(16, 41), capability: 'pr.create', label: 'Open PR', target: 'PR #42' }),
  item({ at: at(16, 55), capability: 'pr.merge', label: 'Merge PR', decision: 'refused', reason: 'the merge did not go through', target: 'PR #42' }),
  item({ at: at(16, 56), capability: 'pr.close', label: 'Close PR', decision: 'refused', reason: "not this task's PR", target: 'PR #38' }),
];
const QUIET_ITEMS: AccessItem[] = [item({ count: 2, expiresAt: at(18, 3) }), item({ capability: 'pr.create', label: 'Open PR', target: 'PR #57' })];

const QUIET: AgentAccessReport = { windowHours: 24, granted: 41, adminGranted: 2, grantProblems: [], refusals: [], healthy: true };
const BUSY: AgentAccessReport = {
  windowHours: 24, granted: 41, adminGranted: 2, healthy: false,
  grantProblems: [
    { workspaceId: 'w1', workspaceName: 'docs-site', reason: 'the GitHub App installation is suspended', fix: 'Unsuspend the GitHub App installation for this repo.', count: 6, lastAt: at(17, 40) },
    { workspaceId: 'w2', workspaceName: 'scratch', reason: 'the workspace has no linked GitHub repo', fix: 'Link a GitHub repo to the workspace.', count: 1, lastAt: at(15, 2) },
  ],
  refusals: [
    { label: 'Merge PR', reason: "not this task's PR", count: 4 },
    { label: 'Open PR', reason: 'a protected branch', count: 1 },
  ],
};

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      <p className="text-eyebrow font-bold uppercase tracking-[2px] text-text-muted mb-3">{title}</p>
      {children}
    </section>
  );
}

export default function AgentAccessFixture() {
  return (
    <DisplayTimezoneProvider teamTimezone="America/New_York">
      <div className="max-w-3xl mx-auto p-4 md:p-8">
        <Frame title="Task page · something refused (opens itself)"><TaskAccessSection items={WITH_REFUSALS} /></Frame>
        <Frame title="Task page · nothing refused (collapsed)"><TaskAccessSection items={QUIET_ITEMS} /></Frame>
        <Frame title="Health · quiet"><AgentAccessSection report={QUIET} /></Frame>
        <Frame title="Health · problems and refusals"><AgentAccessSection report={BUSY} /></Frame>
      </div>
    </DisplayTimezoneProvider>
  );
}
