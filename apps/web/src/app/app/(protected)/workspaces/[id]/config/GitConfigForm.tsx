'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface GitConfig {
    defaultBranch: string;
    branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
    branchPrefix?: string;
    useBuildBranch?: boolean;
    commitStyle: 'conventional' | 'freeform' | 'custom';
    commitPrefix?: string;
    requiresPR: boolean;
    targetBranch?: string;
    autoCreatePR: boolean;
    agentInstructions?: string;
    useClaudeMd: boolean;
    bypassPermissions?: boolean;
    pluginPaths?: string[];
    sandbox?: {
        enabled?: boolean;
        autoAllowBashIfSandboxed?: boolean;
        network?: {
            allowedDomains?: string[];
            allowLocalBinding?: boolean;
        };
        excludedCommands?: string[];
    };
}

interface Props {
    workspaceId: string;
    workspaceName: string;
    initialConfig?: GitConfig | null;
    configStatus: 'unconfigured' | 'admin_confirmed';
}

export function GitConfigForm({ workspaceId, workspaceName, initialConfig, configStatus }: Props) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Form state
    const [defaultBranch, setDefaultBranch] = useState(initialConfig?.defaultBranch || 'main');
    const [branchingStrategy, setBranchingStrategy] = useState<GitConfig['branchingStrategy']>(
        initialConfig?.branchingStrategy || 'feature'
    );
    const [branchPrefix, setBranchPrefix] = useState(initialConfig?.branchPrefix || '');
    const [useBuildBranch, setUseBuildBranch] = useState(initialConfig?.useBuildBranch || false);
    const [commitStyle, setCommitStyle] = useState<GitConfig['commitStyle']>(
        initialConfig?.commitStyle || 'freeform'
    );
    const [requiresPR, setRequiresPR] = useState(initialConfig?.requiresPR || false);
    const [targetBranch, setTargetBranch] = useState(initialConfig?.targetBranch || '');
    const [autoCreatePR, setAutoCreatePR] = useState(initialConfig?.autoCreatePR || false);
    const [agentInstructions, setAgentInstructions] = useState(initialConfig?.agentInstructions || '');
    const [useClaudeMd, setUseClaudeMd] = useState(initialConfig?.useClaudeMd ?? true);
    const [bypassPermissions, setBypassPermissions] = useState(initialConfig?.bypassPermissions || false);
    const [pluginPaths, setPluginPaths] = useState((initialConfig?.pluginPaths || []).join('\n'));
    const [sandboxEnabled, setSandboxEnabled] = useState(initialConfig?.sandbox?.enabled || false);
    const [sandboxAutoAllowBash, setSandboxAutoAllowBash] = useState(initialConfig?.sandbox?.autoAllowBashIfSandboxed || false);
    const [sandboxAllowedDomains, setSandboxAllowedDomains] = useState((initialConfig?.sandbox?.network?.allowedDomains || []).join('\n'));
    const [sandboxAllowLocalBinding, setSandboxAllowLocalBinding] = useState(initialConfig?.sandbox?.network?.allowLocalBinding || false);
    const [sandboxExcludedCommands, setSandboxExcludedCommands] = useState((initialConfig?.sandbox?.excludedCommands || []).join('\n'));

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        setError(null);
        setSaved(false);

        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    defaultBranch,
                    branchingStrategy,
                    branchPrefix: branchPrefix || undefined,
                    useBuildBranch,
                    commitStyle,
                    requiresPR,
                    targetBranch: targetBranch || undefined,
                    autoCreatePR,
                    agentInstructions: agentInstructions || undefined,
                    useClaudeMd,
                    bypassPermissions,
                    pluginPaths: pluginPaths.split('\n').map(s => s.trim()).filter(Boolean),
                    sandbox: sandboxEnabled ? {
                        enabled: true,
                        autoAllowBashIfSandboxed: sandboxAutoAllowBash,
                        network: {
                            allowedDomains: sandboxAllowedDomains.split('\n').map(s => s.trim()).filter(Boolean),
                            allowLocalBinding: sandboxAllowLocalBinding,
                        },
                        excludedCommands: sandboxExcludedCommands.split('\n').map(s => s.trim()).filter(Boolean),
                    } : undefined,
                }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to save');
            }

            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {/* Status Banner */}
            {configStatus === 'unconfigured' && (
                <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-4">
                    <p className="text-sm text-status-warning">
                        This workspace hasn't been configured yet. Set up your git workflow below.
                    </p>
                </div>
            )}

            {/* Branching Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Branching</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Default Branch</label>
                        <input
                            type="text"
                            value={defaultBranch}
                            onChange={(e) => setDefaultBranch(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                            placeholder="main"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Branching Strategy</label>
                        <select
                            value={branchingStrategy}
                            onChange={(e) => setBranchingStrategy(e.target.value as GitConfig['branchingStrategy'])}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                        >
                            <option value="none">None (use CLAUDE.md / project conventions)</option>
                            <option value="trunk">Trunk-based (commit directly to default branch)</option>
                            <option value="feature">Feature branches</option>
                            <option value="gitflow">GitFlow (develop + feature branches)</option>
                            <option value="custom">Custom</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Branch Prefix</label>
                        <input
                            type="text"
                            value={branchPrefix}
                            onChange={(e) => setBranchPrefix(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                            placeholder="feature/"
                        />
                        <p className="text-xs text-text-muted mt-1">Leave empty to let agent follow project conventions</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="useBuildBranch"
                            checked={useBuildBranch}
                            onChange={(e) => setUseBuildBranch(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="useBuildBranch" className="text-sm">
                            Use Buildd branch naming (<code>buildd/task-id-title</code>)
                        </label>
                    </div>
                </div>
            </div>

            {/* Commit Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Commits</h3>

                <div>
                    <label className="block text-sm font-medium mb-1">Commit Style</label>
                    <select
                        value={commitStyle}
                        onChange={(e) => setCommitStyle(e.target.value as GitConfig['commitStyle'])}
                        className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                    >
                        <option value="freeform">Freeform</option>
                        <option value="conventional">Conventional Commits (feat:, fix:, etc.)</option>
                        <option value="custom">Custom</option>
                    </select>
                </div>
            </div>

            {/* PR Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Pull Requests</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="requiresPR"
                            checked={requiresPR}
                            onChange={(e) => setRequiresPR(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="requiresPR" className="text-sm">
                            Changes require Pull Request
                        </label>
                    </div>

                    {requiresPR && (
                        <>
                            <div>
                                <label className="block text-sm font-medium mb-1">Target Branch for PRs</label>
                                <input
                                    type="text"
                                    value={targetBranch}
                                    onChange={(e) => setTargetBranch(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
                                    placeholder={defaultBranch || 'main'}
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="autoCreatePR"
                                    checked={autoCreatePR}
                                    onChange={(e) => setAutoCreatePR(e.target.checked)}
                                    className="rounded"
                                />
                                <label htmlFor="autoCreatePR" className="text-sm">
                                    Auto-create PR when task completes
                                </label>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Agent Instructions Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Agent Instructions</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="useClaudeMd"
                            checked={useClaudeMd}
                            onChange={(e) => setUseClaudeMd(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="useClaudeMd" className="text-sm">
                            Load CLAUDE.md from repository (recommended)
                        </label>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Additional Instructions
                            <span className="text-text-muted font-normal ml-1">(prepended to every task)</span>
                        </label>
                        <textarea
                            value={agentInstructions}
                            onChange={(e) => setAgentInstructions(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[120px] font-mono text-sm"
                            placeholder="Always run tests before committing.&#10;Use npm run lint to check code style."
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="bypassPermissions"
                            checked={bypassPermissions}
                            onChange={(e) => setBypassPermissions(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="bypassPermissions" className="text-sm">
                            Bypass permission prompts
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        Allow agents to run bash commands without approval. Dangerous commands (sudo, rm -rf /, etc.) are always blocked.
                    </p>
                </div>
            </div>

            {/* Plugins Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Plugins</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Plugin Directories
                            <span className="text-text-muted font-normal ml-1">(one path per line)</span>
                        </label>
                        <textarea
                            value={pluginPaths}
                            onChange={(e) => setPluginPaths(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[80px] font-mono text-sm"
                            placeholder={"./plugins/linter\n/home/team/shared-plugins/deploy"}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Paths to plugin directories (containing <code>.claude-plugin/plugin.json</code>). Loaded when workers start tasks.
                        </p>
                    </div>
                </div>
            </div>

            {/* Sandbox Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Sandbox</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="sandboxEnabled"
                            checked={sandboxEnabled}
                            onChange={(e) => setSandboxEnabled(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="sandboxEnabled" className="text-sm">
                            Enable sandbox isolation
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        Restrict worker file and network access using the SDK sandbox. Prevents workers from accessing unauthorized resources.
                    </p>

                    {sandboxEnabled && (
                        <div className="space-y-4 pl-6 border-l-2 border-border-default">
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="sandboxAutoAllowBash"
                                    checked={sandboxAutoAllowBash}
                                    onChange={(e) => setSandboxAutoAllowBash(e.target.checked)}
                                    className="rounded"
                                />
                                <label htmlFor="sandboxAutoAllowBash" className="text-sm">
                                    Auto-allow bash commands when sandboxed
                                </label>
                            </div>
                            <p className="text-xs text-text-muted -mt-2">
                                Skip bash permission prompts since the sandbox restricts what commands can do.
                            </p>

                            <div>
                                <label className="block text-sm font-medium mb-1">
                                    Allowed Domains
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxAllowedDomains}
                                    onChange={(e) => setSandboxAllowedDomains(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[80px] font-mono text-sm"
                                    placeholder={"api.github.com\nnpm.pkg.github.com\nregistry.npmjs.org"}
                                />
                                <p className="text-xs text-text-muted mt-1">
                                    Network domains workers are allowed to access. Leave empty to block all outbound network.
                                </p>
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="sandboxAllowLocalBinding"
                                    checked={sandboxAllowLocalBinding}
                                    onChange={(e) => setSandboxAllowLocalBinding(e.target.checked)}
                                    className="rounded"
                                />
                                <label htmlFor="sandboxAllowLocalBinding" className="text-sm">
                                    Allow binding to localhost
                                </label>
                            </div>
                            <p className="text-xs text-text-muted -mt-2">
                                Allow workers to start local dev servers (e.g., for running tests that need a server).
                            </p>

                            <div>
                                <label className="block text-sm font-medium mb-1">
                                    Excluded Commands
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxExcludedCommands}
                                    onChange={(e) => setSandboxExcludedCommands(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[80px] font-mono text-sm"
                                    placeholder={"docker\nkubectl\nssh"}
                                />
                                <p className="text-xs text-text-muted mt-1">
                                    Commands excluded from sandbox restrictions (run outside the sandbox).
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-4">
                <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save Configuration'}
                </button>

                {saved && (
                    <span className="text-status-success text-sm">Saved</span>
                )}

                {error && (
                    <span className="text-status-error text-sm">{error}</span>
                )}
            </div>
        </form>
    );
}
