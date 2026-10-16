'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Select } from '@/components/ui/Select';
import { ReadOnlyFacts, type Fact } from './ReadOnlyFacts';
import { useDirtyState, useWarnOnUnload } from '@/hooks/useUnsavedChanges';

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
    mergePolicy?: { tier?: 'auto-threshold' | 'agent-review' | 'human' } | null;
}

function describeMergeTier(tier: 'auto-threshold' | 'agent-review' | 'human' | undefined): string {
    if (tier === 'human') return 'a person merges every PR';
    if (tier === 'agent-review') return 'a reviewer agent decides each PR';
    return 'auto-merge on green CI, once the safety checks pass';
}

const BRANCHING_OPTIONS = [
    { value: 'none', label: 'None (use CLAUDE.md / project conventions)' },
    { value: 'trunk', label: 'Trunk-based (commit directly to default branch)' },
    { value: 'feature', label: 'Feature branches' },
    { value: 'gitflow', label: 'GitFlow (develop + feature branches)' },
    { value: 'custom', label: 'Custom' },
];

const COMMIT_OPTIONS = [
    { value: 'freeform', label: 'Freeform' },
    { value: 'conventional', label: 'Conventional Commits (feat:, fix:, etc.)' },
    { value: 'custom', label: 'Custom' },
];

const THINKING_OPTIONS = [
    { value: 'none', label: 'Default (no override)' },
    { value: 'adaptive', label: 'Adaptive (model decides when to think)' },
    { value: 'enabled', label: 'Enabled (fixed budget)' },
    { value: 'disabled', label: 'Disabled' },
];

const EFFORT_OPTIONS = [
    { value: 'none', label: 'Default (no override)' },
    { value: 'low', label: 'Low (faster, cheaper · simple tasks)' },
    { value: 'medium', label: 'Medium (balanced)' },
    { value: 'high', label: 'High (thorough)' },
    { value: 'max', label: 'Max (most thorough · complex architecture)' },
];

const BACKEND_OPTIONS = [
    { value: 'default', label: 'Claude (platform default)' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex (OpenAI)' },
];

/** An option's label, for the read-only view. */
function optionLabel(options: Array<{ value: string; label: string }>, value: string): string {
    return options.find(o => o.value === value)?.label ?? value;
}

interface Props {
    workspaceId: string;
    workspaceName: string;
    initialConfig?: GitConfig | null;
    /** Holds manage_workspace_settings. False: every setting as text, no controls. */
    canEdit: boolean;
    /**
     * Which half of gitConfig this form shows and saves: the repository's git
     * workflow, or how agents run. Each saves on its own (the config route's
     * `group`), so saving one never touches the other's fields.
     */
    part: 'repository' | 'agents';
}

export function GitConfigForm({ workspaceId, workspaceName, initialConfig, canEdit, part }: Props) {
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
    const [defaultBackend, setDefaultBackend] = useState<'default' | 'claude' | 'codex'>(
        initialConfig?.defaultBackend || 'default'
    );

    const repositoryPayload = {
        defaultBranch,
        branchingStrategy,
        branchPrefix: branchPrefix || undefined,
        useBuildBranch,
        commitStyle,
        requiresPR,
        targetBranch: targetBranch || undefined,
        autoCreatePR,
    };
    const agentsPayload = {
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
            : thinkingType === 'enabled' ? { type: 'enabled' as const, budgetTokens: thinkingBudgetTokens }
            : { type: thinkingType },
        effort: effort === 'none' ? undefined : effort,
        defaultBackend: defaultBackend === 'default' ? undefined : defaultBackend,
    };
    const payload = part === 'repository' ? repositoryPayload : agentsPayload;
    const { dirty, snapshot, markSaved } = useDirtyState<Record<string, unknown>>(payload);
    useWarnOnUnload(canEdit && dirty);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!dirty) return;
        const submitted = snapshot;
        setSaving(true);
        setError(null);
        setSaved(false);

        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group: part, ...payload }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Could not save. Try again.');
            }

            markSaved(submitted);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save. Try again.');
        } finally {
            setSaving(false);
        }
    }

    // Who merges is the merge policy's call, not a checkbox here: the old
    // "Auto-merge on green CI" toggle wrote a flag no merge gate reads.
    const mergingLine = (
        <p data-testid="git-config-merge-policy" className="text-xs text-text-secondary">
            <span className="font-medium text-text-primary">Merging:</span>{' '}
            {describeMergeTier(initialConfig?.mergePolicy?.tier)}
            {!initialConfig?.mergePolicy?.tier && ' (default)'}.{' '}
            Set by the workspace{' '}
            <Link href={`/app/settings/workspace/${workspaceId}`} className="underline">merge policy</Link>;
            a mission or a task that requires review can override it.
        </p>
    );

    if (!canEdit) {
        const onOff = (v: boolean) => (v ? 'On' : 'Off');
        const mono = (v: string) => <span className="font-mono">{v}</span>;
        const lines = (v: string) => v.split('\n').map(l => l.trim()).filter(Boolean).join(', ') || 'None';
        const repositoryGroups: Array<{ title: string; facts: Fact[]; after?: React.ReactNode }> = [
            {
                title: 'Branching',
                facts: [
                    { label: 'Default branch', value: mono(defaultBranch) },
                    { label: 'Git workflow', value: optionLabel(BRANCHING_OPTIONS, branchingStrategy) },
                    { label: 'Branch prefix', value: branchPrefix ? mono(branchPrefix) : 'None' },
                    { label: 'buildd branch naming', value: onOff(useBuildBranch) },
                ],
            },
            {
                title: 'Commits',
                facts: [{ label: 'Commit style', value: optionLabel(COMMIT_OPTIONS, commitStyle) }],
            },
            {
                title: 'Pull requests',
                facts: [
                    { label: 'Changes require a pull request', value: onOff(requiresPR) },
                    { label: 'PR target branch', value: mono(targetBranch || defaultBranch || 'main') },
                    ...(requiresPR ? [{ label: 'Auto-create PR when task completes', value: onOff(autoCreatePR) }] : []),
                ],
                after: mergingLine,
            },
        ];
        const agentGroups: Array<{ title: string; facts: Fact[]; after?: React.ReactNode }> = [
            {
                title: 'Instructions and permissions',
                facts: [
                    { label: 'Load CLAUDE.md from repository', value: onOff(useClaudeMd) },
                    {
                        label: 'Additional instructions',
                        value: agentInstructions
                            ? <span className="block whitespace-pre-wrap font-mono text-left">{agentInstructions}</span>
                            : 'None',
                    },
                    { label: 'Bypass permission prompts', value: onOff(bypassPermissions) },
                ],
            },
            {
                title: 'Sandbox',
                facts: [
                    { label: 'Sandbox isolation', value: onOff(sandboxEnabled) },
                    ...(sandboxEnabled
                        ? [
                            { label: 'Auto-allow bash commands when sandboxed', value: onOff(sandboxAutoAllowBash) },
                            { label: 'Allowed domains', value: lines(sandboxAllowedDomains) },
                            { label: 'Allow binding to localhost', value: onOff(sandboxAllowLocalBinding) },
                            { label: 'Excluded commands', value: lines(sandboxExcludedCommands) },
                        ]
                        : []),
                ],
            },
            {
                title: 'Model',
                facts: [
                    { label: 'Agent backend', value: optionLabel(BACKEND_OPTIONS, defaultBackend) },
                    { label: 'Fallback model', value: fallbackModel ? mono(fallbackModel) : 'None' },
                    { label: 'Thinking mode', value: optionLabel(THINKING_OPTIONS, thinkingType) },
                    ...(thinkingType === 'enabled' ? [{ label: 'Budget tokens', value: mono(String(thinkingBudgetTokens)) }] : []),
                    { label: 'Effort level', value: optionLabel(EFFORT_OPTIONS, effort) },
                ],
            },
            {
                title: 'Advanced',
                facts: [
                    { label: 'Debug logs', value: onOff(debug) },
                    { label: 'Debug log file', value: debugFile ? mono(debugFile) : 'None' },
                ],
            },
        ];
        const groups = part === 'repository' ? repositoryGroups : agentGroups;
        return (
            <div className="py-4 first:pt-0 last:pb-0 divide-y divide-border-default" data-testid="git-config-read-only">
                {groups.map(g => (
                    <div key={g.title} className="py-4 first:pt-0 last:pb-0">
                        <h3 className="text-sm font-medium text-text-primary mb-3">{g.title}</h3>
                        <ReadOnlyFacts facts={g.facts} />
                        {g.after && <div className="mt-3">{g.after}</div>}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="py-4 first:pt-0 last:pb-0">
            {/* Unconfigured status is reported by the Workspace health row above the form. */}
            <div className="divide-y divide-border-default">

            {part === 'repository' && (<>
            {/* Branching Section */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Branching</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm text-text-primary mb-1">Default branch</label>
                        <input
                            type="text"
                            value={defaultBranch}
                            onChange={(e) => setDefaultBranch(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
                            placeholder="main"
                        />
                        <p className="text-xs text-text-muted mt-1">Base for new feature branches, such as <code>dev</code> or <code>main</code>.</p>
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">Git workflow</label>
                        <Select
                            value={branchingStrategy}
                            onChange={(v) => setBranchingStrategy(v as GitConfig['branchingStrategy'])}
                            options={BRANCHING_OPTIONS}
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">Branch prefix</label>
                        <input
                            type="text"
                            value={branchPrefix}
                            onChange={(e) => setBranchPrefix(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
                            placeholder="feature/"
                        />
                        <p className="text-xs text-text-muted mt-1">Optional. Empty follows project conventions.</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="useBuildBranch"
                            checked={useBuildBranch}
                            onChange={(e) => setUseBuildBranch(e.target.checked)}
                        />
                        <label htmlFor="useBuildBranch" className="text-sm">
                            Use buildd branch naming (<code>buildd/task-id-title</code>)
                        </label>
                    </div>
                </div>
            </div>

            {/* Commit Section */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Commits</h3>

                <div>
                    <label className="block text-sm text-text-primary mb-1">Commit style</label>
                    <Select
                        value={commitStyle}
                        onChange={(v) => setCommitStyle(v as GitConfig['commitStyle'])}
                        options={COMMIT_OPTIONS}
                    />
                </div>
            </div>

            {/* PR Section */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Pull requests</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="requiresPR"
                            checked={requiresPR}
                            onChange={(e) => setRequiresPR(e.target.checked)}
                        />
                        <label htmlFor="requiresPR" className="text-sm">
                            Changes require a pull request
                        </label>
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">PR target branch</label>
                        <input
                            type="text"
                            value={targetBranch}
                            onChange={(e) => setTargetBranch(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
                            placeholder={defaultBranch || 'main'}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Branch agents open pull requests against, such as <code>dev</code>.
                            Empty falls back to Default branch, then the repository&apos;s default branch on GitHub.
                        </p>
                        {!targetBranch && (
                            <p className="text-xs text-status-warning mt-1">
                                Empty. PRs target <code>{defaultBranch || 'main'}</code>.
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
                                />
                            <label htmlFor="autoCreatePR" className="text-sm">
                                Auto-create PR when task completes
                            </label>
                        </div>
                    )}

                    {mergingLine}
                </div>
            </div>

            </>)}

            {part === 'agents' && (<>
            {/* Agent Instructions Section */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Instructions and permissions</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="useClaudeMd"
                            checked={useClaudeMd}
                            onChange={(e) => setUseClaudeMd(e.target.checked)}
                        />
                        <label htmlFor="useClaudeMd" className="text-sm">
                            Load CLAUDE.md from repository (recommended)
                        </label>
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">
                            Additional instructions
                            <span className="text-text-muted font-normal ml-1">(prepended to every task)</span>
                        </label>
                        <textarea
                            value={agentInstructions}
                            onChange={(e) => setAgentInstructions(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 min-h-[120px] font-mono text-base md:text-sm"
                            placeholder="Always run tests before committing.&#10;Use npm run lint to check code style."
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="bypassPermissions"
                            checked={bypassPermissions}
                            onChange={(e) => setBypassPermissions(e.target.checked)}
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

            {/* Sandbox Section */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Sandbox</h3>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="sandboxEnabled"
                            checked={sandboxEnabled}
                            onChange={(e) => setSandboxEnabled(e.target.checked)}
                        />
                        <label htmlFor="sandboxEnabled" className="text-sm">
                            Enable sandbox isolation
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        Limits the files and domains agents can reach.
                    </p>

                    {sandboxEnabled && (
                        <div className="space-y-4 pl-4 border-l border-border-default">
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="sandboxAutoAllowBash"
                                    checked={sandboxAutoAllowBash}
                                    onChange={(e) => setSandboxAutoAllowBash(e.target.checked)}
                                        />
                                <label htmlFor="sandboxAutoAllowBash" className="text-sm">
                                    Auto-allow bash commands when sandboxed
                                </label>
                            </div>
                            <p className="text-xs text-text-muted -mt-2">
                                Skips bash permission prompts inside the sandbox.
                            </p>

                            <div>
                                <label className="block text-sm text-text-primary mb-1">
                                    Allowed domains
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxAllowedDomains}
                                    onChange={(e) => setSandboxAllowedDomains(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default bg-surface-1 min-h-[80px] font-mono text-base md:text-sm"
                                    placeholder={"api.github.com\nnpm.pkg.github.com\nregistry.npmjs.org"}
                                />
                                <p className="text-xs text-text-muted mt-1">
                                    Domains agents can reach. Empty blocks all network access.
                                </p>
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="sandboxAllowLocalBinding"
                                    checked={sandboxAllowLocalBinding}
                                    onChange={(e) => setSandboxAllowLocalBinding(e.target.checked)}
                                        />
                                <label htmlFor="sandboxAllowLocalBinding" className="text-sm">
                                    Allow binding to localhost
                                </label>
                            </div>
                            <p className="text-xs text-text-muted -mt-2">
                                Allows agents to start local servers, such as for tests.
                            </p>

                            <div>
                                <label className="block text-sm text-text-primary mb-1">
                                    Excluded commands
                                    <span className="text-text-muted font-normal ml-1">(one per line)</span>
                                </label>
                                <textarea
                                    value={sandboxExcludedCommands}
                                    onChange={(e) => setSandboxExcludedCommands(e.target.value)}
                                    className="w-full px-3 py-2 border border-border-default bg-surface-1 min-h-[80px] font-mono text-base md:text-sm"
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

            {/* Model */}
            <div className="py-4 first:pt-0">
                <h3 className="text-sm font-medium text-text-primary mb-3">Model</h3>
                <p className="text-xs text-text-muted mb-4">
                    Ignored on models that don&apos;t support them.
                </p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm text-text-primary mb-1">Agent backend</label>
                        <Select
                            value={defaultBackend}
                            onChange={(v) => setDefaultBackend(v as typeof defaultBackend)}
                            options={BACKEND_OPTIONS}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Default for new tasks here, unless a task or its agent sets one. Codex needs a connected ChatGPT or OpenAI account.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">
                            Fallback model
                            <span className="text-text-muted font-normal ml-1">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={fallbackModel}
                            onChange={(e) => setFallbackModel(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 font-mono text-base md:text-sm"
                            placeholder="A tier or a model name"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Used when the primary model fails, such as on a rate limit. Tasks can override this.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">Thinking mode</label>
                        <Select
                            value={thinkingType}
                            onChange={(v) => setThinkingType(v as typeof thinkingType)}
                            options={THINKING_OPTIONS}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Extended thinking for agents. Tasks can override this.
                        </p>
                    </div>

                    {thinkingType === 'enabled' && (
                        <div className="pl-4 border-l border-border-default">
                            <label className="block text-sm text-text-primary mb-1">
                                Budget tokens
                            </label>
                            <input
                                type="number"
                                value={thinkingBudgetTokens}
                                onChange={(e) => setThinkingBudgetTokens(Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-3 py-2 border border-border-default bg-surface-1 font-mono text-base md:text-sm"
                                min={1}
                                step={1000}
                                placeholder="10000"
                            />
                            <p className="text-xs text-text-muted mt-1">
                                Maximum tokens spent on thinking. Higher budgets cost more.
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="block text-sm text-text-primary mb-1">Effort level</label>
                        <Select
                            value={effort}
                            onChange={(v) => setEffort(v as typeof effort)}
                            options={EFFORT_OPTIONS}
                        />
                        <p className="text-xs text-text-muted mt-1">
                            How much effort the model spends per response. Tasks can override this.
                        </p>
                    </div>
                </div>
            </div>

            {/* Advanced: closed by default */}
            <details className="group py-4 first:pt-0" data-testid="git-config-advanced">
                <summary className="flex min-h-11 md:min-h-0 cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-text-primary [&::-webkit-details-marker]:hidden">
                    <span aria-hidden className="text-text-muted transition-transform group-open:rotate-90">›</span>
                    Advanced
                </summary>

                <div className="space-y-4 mt-3">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="debug"
                            checked={debug}
                            onChange={(e) => setDebug(e.target.checked)}
                        />
                        <label htmlFor="debug" className="text-sm">
                            Write debug logs
                        </label>
                    </div>
                    <p className="text-xs text-text-muted -mt-2">
                        Detailed agent logs for troubleshooting.
                    </p>

                    <div>
                        <label className="block text-sm text-text-primary mb-1">
                            Debug log file
                            <span className="text-text-muted font-normal ml-1">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={debugFile}
                            onChange={(e) => setDebugFile(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default bg-surface-1 font-mono text-base md:text-sm"
                            placeholder="/tmp/buildd-debug.log"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            Path for the debug log.
                        </p>
                    </div>
                </div>
            </details>

            </>)}

            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-4 pt-4">
                <button
                    type="submit"
                    disabled={saving || !dirty}
                    className="btn min-h-11"
                >
                    {saving ? 'Saving…' : 'Save'}
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
