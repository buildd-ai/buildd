'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RepoAccessView } from '@/lib/github-repo-access-store';

interface Props {
    workspaceId: string;
    initialView: RepoAccessView;
    /** manage_workspace_settings — Check connection re-links the repo and re-queues tasks. */
    canCheck: boolean;
}

const BUTTON = 'btn min-h-11 shrink-0';

/**
 * Whether Buildd's GitHub App can act on this workspace's existing repository,
 * and if not, the one thing that is missing and who can fix it. Rules and copy
 * live in `lib/github-repo-access.ts`; this renders them and wires:
 *
 *   Grant GitHub access       → the installation's own GitHub settings page
 *                               (only offered when Buildd knows this person can
 *                               change it there)
 *   Ask a GitHub administrator→ copies short instructions with the repo and link
 *   Check connection          → POST /api/workspaces/[id]/github-access
 *
 * Nothing here changes GitHub or creates a repository.
 */
export function RepoAccessCard({ workspaceId, initialView, canCheck }: Props) {
    const [view, setView] = useState(initialView);
    const [checking, setChecking] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const r = view.remediation;

    async function checkConnection() {
        setChecking(true);
        setResult(null);
        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/github-access`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                setResult(data.error ?? 'Could not check the connection.');
                return;
            }
            setView(data.view);
            if (data.verified) {
                setResult(data.resumed > 0
                    ? `Connected. ${data.resumed} waiting task${data.resumed === 1 ? '' : 's'} resumed.`
                    : 'Connected.');
            } else {
                setResult('Still not reachable. Nothing changed on GitHub yet.');
            }
        } catch {
            setResult('Could not check the connection.');
        } finally {
            setChecking(false);
        }
    }

    async function copyInstructions() {
        if (!r?.adminInstructions) return;
        try {
            await navigator.clipboard.writeText(r.adminInstructions);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // The instructions stay visible below for a manual copy.
        }
    }

    // Re-reading GitHub cannot fix a server with no App; don't offer it there.
    const checkable = canCheck && view.remediation?.reason !== 'app_not_configured';
    const checkButton = checkable && (
        <button type="button" className={BUTTON} onClick={checkConnection} disabled={checking} data-testid="repo-access-check">
            {checking ? 'Checking…' : 'Check connection'}
        </button>
    );

    if (view.ok && !r) {
        return (
            <div id="github-access" className="py-4 first:pt-0 last:pb-0 scroll-mt-20" data-testid="repo-access-card">
                <h3 className="text-sm font-medium text-text-primary mb-0.5">GitHub access</h3>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-text-secondary">
                        Buildd can open pull requests on <span className="font-mono text-text-primary">{view.repo}</span>.
                    </p>
                    {checkButton}
                </div>
                {result && <p className="text-xs text-text-muted mt-2" role="status">{result}</p>}
            </div>
        );
    }

    if (!r) return null;

    const action = r.action;
    let primary: React.ReactNode = null;
    if (action.kind === 'grant' && action.url) {
        primary = (
            <a href={action.url} target="_blank" rel="noopener noreferrer" className={`${BUTTON} btn-primary inline-flex items-center`} data-testid="repo-access-grant">
                {action.label}
            </a>
        );
    } else if (action.kind === 'ask_admin' && r.adminInstructions) {
        primary = (
            <button type="button" className={`${BUTTON} btn-primary`} onClick={copyInstructions} data-testid="repo-access-ask-admin">
                {copied ? 'Copied' : action.label}
            </button>
        );
    } else if (action.kind === 'link_repo') {
        primary = (
            <Link href={`/app/workspaces/${workspaceId}`} className={`${BUTTON} btn-primary inline-flex items-center`}>
                {action.label}
            </Link>
        );
    }

    return (
        <div id="github-access" className="py-4 first:pt-0 last:pb-0 scroll-mt-20" data-testid="repo-access-card" data-reason={r.reason}>
            <h3 className="text-sm font-medium text-text-primary mb-0.5">{r.title}</h3>
            <p className="text-xs text-text-secondary">{r.message}</p>
            {view.waitingTasks > 0 && (
                <p className="text-xs text-text-muted mt-1" data-testid="repo-access-waiting">
                    {view.waitingTasks === 1 ? '1 task is' : `${view.waitingTasks} tasks are`} waiting for this and will resume on their own once access is verified.
                </p>
            )}

            {action.kind === 'ask_admin' && r.adminInstructions && (
                <div className="mt-3">
                    <p className="text-xs text-text-muted mb-1">Send this to someone who administers it on GitHub:</p>
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words border border-border-default p-2 text-text-secondary" data-testid="repo-access-instructions">
                        {r.adminInstructions}
                    </pre>
                </div>
            )}
            {action.kind === 'check_connection' && !canCheck && (
                <p className="text-xs text-text-muted mt-2">A workspace admin can fix this with Check connection on this page.</p>
            )}
            {action.kind === 'operator' && (
                <p className="text-xs text-text-muted mt-2">{action.label}.</p>
            )}

            {(primary || checkButton) && (
                <div className="flex flex-col gap-2 mt-3 sm:flex-row sm:items-center">
                    {primary}
                    {checkButton}
                </div>
            )}

            {/* Buildd cannot see GitHub roles. When it cannot vouch for this
                person, the GitHub page is still one click away for whoever
                does administer the account — GitHub refuses everyone else. */}
            {action.kind === 'ask_admin' && r.githubUrl && (
                <p className="text-xs text-text-muted mt-2">
                    Administer it on GitHub yourself?{' '}
                    <a href={r.githubUrl} target="_blank" rel="noopener noreferrer" className="underline" data-testid="repo-access-self-admin">
                        Open GitHub
                    </a>
                </p>
            )}
            {checkable && action.kind !== 'check_connection' && action.kind !== 'operator' && action.kind !== 'link_repo' && (
                <p className="text-xs text-text-muted mt-2">After the change on GitHub, Buildd usually notices on its own. If not, press Check connection.</p>
            )}
            {result && <p className="text-xs text-text-muted mt-2" role="status">{result}</p>}
        </div>
    );
}
