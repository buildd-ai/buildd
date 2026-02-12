'use client';

import { useState } from 'react';

interface WebhookConfig {
    url: string;
    token: string;
    enabled: boolean;
    runnerPreference?: 'any' | 'user' | 'service' | 'action';
}

interface Props {
    workspaceId: string;
    initialConfig?: WebhookConfig | null;
}

export function WebhookConfigForm({ workspaceId, initialConfig }: Props) {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [enabled, setEnabled] = useState(initialConfig?.enabled ?? false);
    const [url, setUrl] = useState(initialConfig?.url || '');
    const [token, setToken] = useState(initialConfig?.token || '');

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        setError(null);
        setSaved(false);

        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/webhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: url.trim() || undefined,
                    token: token.trim() || undefined,
                    enabled,
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

    async function handleTest() {
        if (!url.trim()) return;
        setTesting(true);
        setTestResult(null);

        try {
            const res = await fetch(`/api/workspaces/${workspaceId}/webhook/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url.trim(), token: token.trim() }),
            });

            const data = await res.json();
            setTestResult({
                ok: res.ok,
                message: data.message || (res.ok ? 'Connection successful' : 'Connection failed'),
            });
        } catch {
            setTestResult({ ok: false, message: 'Failed to reach test endpoint' });
        } finally {
            setTesting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="border border-border-default rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-medium">Webhook Endpoint</h3>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <span className="text-sm text-text-muted">{enabled ? 'Active' : 'Disabled'}</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            onClick={() => setEnabled(!enabled)}
                            className={`relative w-10 h-6 rounded-full transition-colors ${
                                enabled ? 'bg-status-success' : 'bg-surface-4'
                            }`}
                        >
                            <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                                enabled ? 'translate-x-4' : ''
                            }`} />
                        </button>
                    </label>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Webhook URL</label>
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
                            placeholder="http://localhost:18789/hooks/agent"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            For OpenClaw, use your Gateway's <code>/hooks/agent</code> endpoint
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1">Bearer Token</label>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
                            placeholder="your-webhook-secret"
                        />
                        <p className="text-xs text-text-muted mt-1">
                            The <code>hooks.token</code> value from your agent config
                        </p>
                    </div>

                    {url.trim() && (
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleTest}
                                disabled={testing}
                                className="px-3 py-1.5 text-sm border border-border-default rounded-md hover:bg-surface-3 disabled:opacity-50"
                            >
                                {testing ? 'Testing...' : 'Test Connection'}
                            </button>
                            {testResult && (
                                <span className={`text-sm ${testResult.ok ? 'text-status-success' : 'text-status-error'}`}>
                                    {testResult.message}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {enabled && url.trim() && (
                <div className="bg-primary/10 border border-primary/30 rounded-lg p-4">
                    <p className="text-sm text-primary">
                        When enabled, new tasks created in this workspace will be sent to the webhook.
                        The agent receives the task description and can report progress back via the Buildd API.
                    </p>
                </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-4">
                <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save Webhook'}
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
