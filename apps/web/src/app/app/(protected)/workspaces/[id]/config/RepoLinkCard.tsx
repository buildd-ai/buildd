'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import RepoPicker from '../../new/RepoPicker';

interface Installation {
    id: string;
    accountLogin: string;
}

interface Repo {
    id: string;
    repoId: number;
    fullName: string;
    name: string;
    owner: string;
    private: boolean;
    defaultBranch: string;
    htmlUrl: string;
    description: string | null;
    hasWorkspace: boolean;
}

const INPUT = 'w-full px-3 py-2 text-base md:text-sm border border-border-default bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary';

/**
 * The missing step 2 of onboarding: a workspace with no repo can link one it
 * can already see, or create a new one. Both go through existing routes:
 *
 *   link   → PATCH /api/workspaces/[id] { repoUrl }  (resolves the GitHub link
 *            only through an installation the workspace's team owns)
 *   create → POST  /api/workspaces/[id]/create-repo  { name, org, private }
 */
export function RepoLinkCard({ workspaceId, onLinked }: { workspaceId: string; onLinked?: () => void }) {
    const router = useRouter();
    const [mode, setMode] = useState<'link' | 'create'>('link');
    const [installations, setInstallations] = useState<Installation[]>([]);
    const [installationId, setInstallationId] = useState('');
    const [repos, setRepos] = useState<Repo[]>([]);
    const [selected, setSelected] = useState<Repo | null>(null);
    const [loadingRepos, setLoadingRepos] = useState(false);
    const [configured, setConfigured] = useState(true);
    const [newName, setNewName] = useState('');
    const [isPrivate, setIsPrivate] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/github/installations')
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (cancelled || !data) return;
                setConfigured(data.configured !== false);
                const list: Installation[] = data.installations || [];
                setInstallations(list);
                if (list.length > 0) setInstallationId(list[0].id);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!installationId) {
            setRepos([]);
            return;
        }
        let cancelled = false;
        setLoadingRepos(true);
        fetch(`/api/github/installations/${installationId}/repos`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (!cancelled) setRepos(data?.repos || []);
            })
            .catch(() => {
                if (!cancelled) setRepos([]);
            })
            .finally(() => {
                if (!cancelled) setLoadingRepos(false);
            });
        return () => {
            cancelled = true;
        };
    }, [installationId]);

    async function submit(url: string, method: 'PATCH' | 'POST', body: Record<string, unknown>) {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setError(err.hint ? `${err.error}. ${err.hint}` : err.error || 'Could not link the repository');
                return;
            }
            onLinked?.();
            router.refresh();
        } catch {
            setError('Network error. Try again.');
        } finally {
            setBusy(false);
        }
    }

    const linkExisting = () => selected && submit(`/api/workspaces/${workspaceId}`, 'PATCH', { repoUrl: selected.fullName });
    const createNew = () => {
        const login = installations.find((i) => i.id === installationId)?.accountLogin;
        return submit(`/api/workspaces/${workspaceId}/create-repo`, 'POST', {
            name: newName.trim(),
            private: isPrivate,
            ...(login ? { org: login } : {}),
        });
    };

    return (
        <section className="card p-4 mb-8" data-testid="repo-link-card">
            <h2 className="section-label mb-1">Link a repository</h2>
            <p className="text-xs text-text-muted mb-3">
                This workspace has no repository yet, so workers have nothing to work in.
            </p>

            {!configured || installations.length === 0 ? (
                <p className="text-sm text-text-secondary" data-testid="repo-link-no-installation">
                    Give the GitHub App access to your account first, then reload. Or set a repo with
                    {' '}<code>manage_workspaces action=update</code>.
                </p>
            ) : (
                <>
                    <div className="flex gap-2 mb-3" role="tablist">
                        {(['link', 'create'] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                role="tab"
                                aria-selected={mode === m}
                                data-testid={`repo-link-tab-${m}`}
                                className={`btn min-h-11 ${mode === m ? 'btn-primary' : ''}`}
                                onClick={() => setMode(m)}
                            >
                                {m === 'link' ? 'Link existing' : 'Create new'}
                            </button>
                        ))}
                    </div>

                    {installations.length > 1 && (
                        <label className="block text-xs text-text-muted mb-3">
                            GitHub account
                            <select
                                className={`${INPUT} mt-1`}
                                value={installationId}
                                onChange={(e) => {
                                    setInstallationId(e.target.value);
                                    setSelected(null);
                                }}
                            >
                                {installations.map((i) => (
                                    <option key={i.id} value={i.id}>{i.accountLogin}</option>
                                ))}
                            </select>
                        </label>
                    )}

                    {mode === 'link' ? (
                        <>
                            <RepoPicker
                                repos={repos}
                                selectedRepos={selected ? [selected] : []}
                                onToggle={(repo) => setSelected((cur) => (cur?.id === repo.id ? null : repo))}
                                loading={loadingRepos}
                            />
                            <button
                                type="button"
                                data-testid="repo-link-submit"
                                className="btn btn-primary min-h-11 mt-3"
                                disabled={!selected || busy}
                                onClick={linkExisting}
                            >
                                {busy ? 'Linking…' : selected ? `Link ${selected.name}` : 'Link repository'}
                            </button>
                        </>
                    ) : (
                        <div className="space-y-3">
                            <label className="block text-xs text-text-muted">
                                Repository name
                                <input
                                    className={`${INPUT} mt-1`}
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    placeholder="my-product"
                                />
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                                Private
                            </label>
                            <button
                                type="button"
                                data-testid="repo-create-submit"
                                className="btn btn-primary min-h-11"
                                disabled={!newName.trim() || busy}
                                onClick={createNew}
                            >
                                {busy ? 'Creating…' : 'Create repository'}
                            </button>
                        </div>
                    )}
                </>
            )}

            {error && (
                <p role="alert" data-testid="repo-link-error" className="text-xs text-status-error mt-3">{error}</p>
            )}
        </section>
    );
}
