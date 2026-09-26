'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { CriteriaGraderControl, normalizeCriteriaGrader, type CriteriaGraderValue } from './CriteriaGraderControl';

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
    fallbackModel?: string;
    sandbox?: {
        enabled?: boolean;
        autoAllowBashIfSandboxed?: boolean;
        network?: {
            allowedDomains?: string[];
            allowLocalBinding?: boolean;
        };
        excludedCommands?: string[];
    };
    debug?: boolean;
    debugFile?: string;
    thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' };
    effort?: 'low' | 'medium' | 'high' | 'max';
    defaultBackend?: 'claude' | 'codex';
    autoMergePR?: boolean;
    autoMergeOnGreenCI?: boolean;
    defaultRunnerPreference?: 'any' | 'user' | 'service' | 'action';
    criteriaGrader?: 'auto' | 'api' | 'runner';
}

interface Props {
    workspaceId: string;
    workspaceName: string;
    initialConfig?: GitConfig | null;
}

export function GitConfigForm({ workspaceId, workspaceName, initialConfig }: Props) {
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
    const [autoMergeOnGreenCI, setAutoMergeOnGreenCI] = useState(initialConfig?.autoMergeOnGreenCI ?? initialConfig?.autoMergePR ?? true);
    const [agentInstructions, setAgentInstructions] = useState(initialConfig?.agentInstructions || '');
    const [useClaudeMd, setUseClaudeMd] = useState(initialConfig?.useClaudeMd ?? true);
    const [bypassPermissions, setBypassPermissions] = useState(initialConfig?.bypassPermissions || false);
    const [fallbackModel, setFallbackModel] = useState(initialConfig?.fallbackModel || '');
    const [sandboxEnabled, setSandboxEnabled] = useState(initialConfig?.sandbox?.enabled || false);
    const [sandboxAutoAllowBash, setSandboxAutoAllowBash] = useState(initialConfig?.sandbox?.autoAllowBashIfSandboxed || false);
    const [sandboxAllowedDomains, setSandboxAllowedDomains] = useState((initialConfig?.sandbox?.network?.allowedDomains || []).join('\n'));
    const [sandboxAllowLocalBinding, setSandboxAllowLocalBinding] = useState(initialConfig?.sandbox?.network?.allowLocalBinding || false);
    const [sandboxExcludedCommands, setSandboxExcludedCommands] = useState((initialConfig?.sandbox?.excludedCommands || []).join('\n'));
    const [debug, setDebug] = useState(initialConfig?.debug || false);
    const [debugFile, setDebugFile] = useState(initialConfig?.debugFile || '');
    const [thinkingType, setThinkingType] = useState<'none' | 'adaptive' | 'enabled' | 'disabled'>(
        initialConfig?.thinking?.type || 'none'
    );
    const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState(
        initialConfig?.thinking?.type === 'enabled' ? initialConfig.thinking.budgetTokens : 10000
    );
    const [effort, setEffort] = useState<'none' | 'low' | 'medium' | 'high' | 'max'>(
        initialConfig?.effort || 'none'
    );
    const [defaultRunnerPreference, setDefaultRunnerPreference] = useState<'any' | 'user' | 'service' | 'action'>(
        initialConfig?.defaultRunnerPreference || 'any'
    );
    const [defaultBackend, setDefaultBackend] = useState<'default' | 'claude' | 'codex'>(
        initialConfig?.defaultBackend || 'default'
    );
    const [criteriaGrader, setCriteriaGrader] = useState<CriteriaGraderValue>(
        normalizeCriteriaGrader(initialConfig?.criteriaGrader)
    );

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
                    autoMergeOnGreenCI,
                    agentInstructions: agentInstructions || undefined,
                    useClaudeMd,
                    bypassPermissions,
                    fallbackModel: fallbackModel.trim() || undefined,
                    sandbox: sandboxEnabled ? {
                        enabled: true,
                        autoAllowBashIfSandboxed: sandboxAutoAllowBash,
                        network: {
                            allowedDomains: sandboxAllowedDomains.split('\n').map(s => s.trim()).filter(Boolean),
                            allowLocalBinding: sandboxAllowLocalBinding,
                        },
                        excludedCommands: sandboxExcludedCommands.split('\n').map(s => s.trim()).filter(Boolean),
                    } : undefined,
                    debug,
                    debugFile: debugFile.trim() || undefined,
                    thinking: thinkingType === 'none' ? undefined
                        : thinkingType === 'enabled' ? { type: 'enabled', budgetTokens: thinkingBudgetTokens }
                        : { type: thinkingType },
                    effort: effort === 'none' ? undefined : effort,
                    defaultRunnerPreference: defaultRunnerPreference !== 'any' ? defaultRunnerPreference : undefined,
                    defaultBackend: defaultBackend === 'default' ? undefined : defaultBackend,
                    criteriaGrader,
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
            {/* Unconfigured status is reported by the Workspace health card above the form. */}

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
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm"
                            placeholder="main"
                        />
                        <p className="text-xs text-text-muted mt-1">Base branch for worktrees and new feature branches, such as <code>dev</code> or <code>main</code>.</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Branching Strategy</label>
                        <Select
                            value={branchingStrategy}
                            onChange={(v) => setBranchingStrategy(v as GitConfig['branchingStrategy'])}
                            options={[
                                { value: 'none', label: 'None (use CLAUDE.md / project conventions)' },
                                { value: 'trunk', label: 'Trunk-based (commit directly to default branch)' },
                                { value: 'feature', label: 'Feature branches' },
                                { value: 'gitflow', label: 'GitFlow (develop + feature branches)' },
                                { value: 'custom', label: 'Custom' },
                            ]}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Branch Prefix</label>
                        <input
                            type="text"
                            value={branchPrefix}
                            onChange={(e) => setBranchPrefix(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm"
                            placeholder="feature/"
                        />
                        <p className="text-xs text-text-muted mt-1">Leave empty and the agent follows project conventions.</p>
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
                            Use buildd branch naming (<code>buildd/task-id-title</code>)
                        </label>
                    </div>
                </div>
            </div>

            {/* Commit Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Commits</h3>

                <div>
                    <label className="block text-sm font-medium mb-1">Commit Style</label>
                    <Select
                        value={commitStyle}
                        onChange={(v) => setCommitStyle(v as GitConfig['commitStyle'])}
                        options={[
                            { value: 'freeform', label: 'Freeform' },
                            { value: 'conventional', label: 'Conventional Commits (feat:, fix:, etc.)' },
                            { value: 'custom', label: 'Custom' },
                        ]}
                    />
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

                    <div>
                        <label className="block text-sm font-medium mb-1">PR Target Branch</label>
                        <input
                            type="text"
                            value={targetBranch}
                            onChange={(e) => setTargetBranch(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 text-base md:text-sm"
                            placeholder={defaultBranch || 'main'}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Branch agents open PRs against. Set <code>dev</code>{' '}if you merge features into dev before releasing to main.
                            If empty, buildd uses Default Branch above, then the GitHub repo&apos;s default branch.
                        </p>
                        {!targetBranch && (
                            <p className="text-xs text-status-warning mt-1">
                                Not set. PRs target <code>{defaultBranch || 'main'}</code> (from Default Branch above).
                            </p>
                        )}
                    </div>

                    {requiresPR && (
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
                    )}

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="autoMergeOnGreenCI"
                            checked={autoMergeOnGreenCI}
                            onChange={(e) => setAutoMergeOnGreenCI(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="autoMergeOnGreenCI" className="text-sm font-medium">
                            Auto-merge on green CI
                            <span className="ml-1.5 text-xs font-normal text-text-muted bg-surface-3 px-1.5 py-0.5 rounded">default: on</span>
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        buildd merges and releases a PR once all CI checks pass. Turn off to review every PR yourself.
                    </p>
                    <p className="text-xs text-text-secondary -mt-1 bg-surface-3/60 border border-border-default rounded px-2.5 py-1.5">
                        Override per task or mission with the <code className="font-mono">requiresReview</code> flag.
                    </p>
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
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[120px] font-mono text-base md:text-sm"
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
                        Agents run bash commands without asking. buildd still blocks dangerous commands such as sudo and rm -rf /.
                    </p>
                </div>
            </div>

            {/* Model Settings Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Model Settings</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Fallback Model
                            <span className="text-text-muted font-normal ml-1">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={fallbackModel}
                            onChange={(e) => setFallbackModel(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm"
                            placeholder="premium-plus · premium · standard · budget · or an exact model id"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Model to use when the primary model fails, such as on a rate limit. Override per task with <code>context.fallbackModel</code>.
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
                        The SDK sandbox limits which files and network hosts workers can reach.
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
                                Skips bash permission prompts. The sandbox limits what commands can do.
                            </p>

                            <div>
                                <label className="block text-sm font-medium mb-1">
                                    Allowed Domains
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxAllowedDomains}
                                    onChange={(e) => setSandboxAllowedDomains(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[80px] font-mono text-base md:text-sm"
                                    placeholder={"api.github.com\nnpm.pkg.github.com\nregistry.npmjs.org"}
                                />
                                <p className="text-xs text-text-muted mt-1">
                                    Domains workers can reach. Leave empty to block all outbound traffic.
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
                                Lets workers start local dev servers, such as for tests that need one.
                            </p>

                            <div>
                                <label className="block text-sm font-medium mb-1">
                                    Excluded Commands
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxExcludedCommands}
                                    onChange={(e) => setSandboxExcludedCommands(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 min-h-[80px] font-mono text-base md:text-sm"
                                    placeholder={"docker\nkubectl\nssh"}
                                />
                                <p className="text-xs text-text-muted mt-1">
                                    These commands run outside the sandbox.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Debug Logging Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Debug Logging</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="debug"
                            checked={debug}
                            onChange={(e) => setDebug(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="debug" className="text-sm">
                            Enable SDK debug logging
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        Writes verbose SDK debug output to stderr, for troubleshooting workers.
                    </p>

                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Debug Log File
                            <span className="text-text-muted font-normal ml-1">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={debugFile}
                            onChange={(e) => setDebugFile(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm"
                            placeholder="/tmp/buildd-debug.log"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Writes SDK debug logs to this file instead of stderr.
                        </p>
                    </div>
                </div>
            </div>

            {/* Thinking / Effort Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Thinking &amp; Effort</h3>
                <p className="text-xs text-text-muted mb-4">
                    Some models don&apos;t support these options. Workers check model capabilities at startup
                    and skip what the model can&apos;t use. Worker logs show a warning when they skip one.
                </p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Thinking Mode</label>
                        <Select
                            value={thinkingType}
                            onChange={(v) => setThinkingType(v as typeof thinkingType)}
                            options={[
                                { value: 'none', label: 'Default (no override)' },
                                { value: 'adaptive', label: 'Adaptive (model decides when to think)' },
                                { value: 'enabled', label: 'Enabled (fixed budget)' },
                                { value: 'disabled', label: 'Disabled' },
                            ]}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Sets extended thinking. Override per task in task context.
                        </p>
                    </div>

                    {thinkingType === 'enabled' && (
                        <div className="pl-6 border-l-2 border-border-default">
                            <label className="block text-sm font-medium mb-1">
                                Budget Tokens
                            </label>
                            <input
                                type="number"
                                value={thinkingBudgetTokens}
                                onChange={(e) => setThinkingBudgetTokens(Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-base md:text-sm"
                                min={1}
                                step={1000}
                                placeholder="10000"
                            />
                            <p className="text-xs text-text-muted mt-1">
                                Most tokens the model can spend thinking. More tokens cost more.
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="block text-sm font-medium mb-1">Effort Level</label>
                        <Select
                            value={effort}
                            onChange={(v) => setEffort(v as typeof effort)}
                            options={[
                                { value: 'none', label: 'Default (no override)' },
                                { value: 'low', label: 'Low (faster, cheaper · simple tasks)' },
                                { value: 'medium', label: 'Medium (balanced)' },
                                { value: 'high', label: 'High (thorough)' },
                                { value: 'max', label: 'Max (most thorough · complex architecture)' },
                            ]}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Sets how much effort the model spends per response. Override per task in task context.
                        </p>
                    </div>
                </div>
            </div>

            {/* Runner Preference Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Default Runner Preference</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Runner Type</label>
                        <Select
                            value={defaultRunnerPreference}
                            onChange={(v) => setDefaultRunnerPreference(v as typeof defaultRunnerPreference)}
                            options={[
                                { value: 'any', label: 'Any runner (no preference)' },
                                { value: 'user', label: 'User runners only (personal / local)' },
                                { value: 'service', label: 'Service runners only (CI / automated)' },
                                { value: 'action', label: 'Action runners only (workflow automation)' },
                            ]}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Applies to new tasks in this workspace. Only runners of this type can claim them. Override per task.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Default Agent Backend</label>
                        <Select
                            value={defaultBackend}
                            onChange={(v) => setDefaultBackend(v as typeof defaultBackend)}
                            options={[
                                { value: 'default', label: 'Claude (platform default)' },
                                { value: 'claude', label: 'Claude' },
                                { value: 'codex', label: 'Codex (OpenAI)' },
                            ]}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Agent engine for new tasks in this workspace. Order: per-task <code>backend</code> → role default → this workspace default → Claude. Codex tasks need a connected ChatGPT/OpenAI credential.
                        </p>
                    </div>
                </div>
            </div>

            {/* Advanced Section */}
            <div className="border border-border-default rounded-lg p-4">
                <h3 className="font-medium mb-4">Advanced</h3>
                <CriteriaGraderControl value={criteriaGrader} onChange={setCriteriaGrader} />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-4">
                <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save Configuration'}
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
