'use client';

import { useState, useEffect, useCallback } from 'react';

interface TeamMember {
  name: string;
  role?: string;
  status: 'active' | 'idle' | 'done';
  spawnedAt: number;
}

interface TeamMessage {
  from: string;
  to: string | 'broadcast';
  content: string;
  summary?: string;
  timestamp: number;
}

interface TeamState {
  teamName: string;
  members: TeamMember[];
  messages: TeamMessage[];
  createdAt: number;
}

interface TeamPanelProps {
  localUiUrl: string;
  viewerToken: string | null;
  workerId: string;
}

export default function TeamPanel({ localUiUrl, viewerToken, workerId }: TeamPanelProps) {
  const [team, setTeam] = useState<TeamState | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState(false);

  const fetchTeam = useCallback(async () => {
    try {
      const url = new URL(`/api/workers/${workerId}/team`, localUiUrl);
      if (viewerToken) url.searchParams.set('token', viewerToken);
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
        mode: 'cors',
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = await res.json();
      setTeam(data.team);
      setError(false);
    } catch {
      setError(true);
    }
  }, [localUiUrl, viewerToken, workerId]);

  // Initial fetch + polling when expanded
  useEffect(() => {
    fetchTeam();
    if (!expanded) return;

    const interval = setInterval(fetchTeam, 5000);
    return () => clearInterval(interval);
  }, [fetchTeam, expanded]);

  if (error || !team) return null;

  const statusDot: Record<string, string> = {
    active: 'bg-status-success',
    idle: 'bg-status-warning',
    done: 'bg-text-muted',
  };

  return (
    <div className="mt-3 border border-border-default bg-surface-2 rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-mono text-text-secondary hover:bg-surface-3 rounded-md"
      >
        <span className="flex items-center gap-2">
          <span className="text-text-muted">{expanded ? '▾' : '▸'}</span>
          Team: {team.teamName}
          <span className="text-text-muted">({team.members.length} agent{team.members.length !== 1 ? 's' : ''})</span>
        </span>
        <span className="text-text-muted">{team.messages.length} msg{team.messages.length !== 1 ? 's' : ''}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Members */}
          <div className="flex flex-wrap gap-2">
            {team.members.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] bg-surface-3 rounded border border-border-default"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot[m.status] || 'bg-text-muted'}`} />
                <span className="text-text-primary font-medium">{m.name}</span>
                {m.role && <span className="text-text-muted">({m.role})</span>}
              </div>
            ))}
          </div>

          {/* Message timeline */}
          {team.messages.length > 0 && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {team.messages.slice(-20).map((msg, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px] font-mono">
                  <span className="text-text-muted whitespace-nowrap">
                    {new Date(msg.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="text-accent-primary">{msg.from}</span>
                  <span className="text-text-muted">→</span>
                  <span className="text-accent-secondary">{msg.to}</span>
                  <span className="text-text-secondary truncate">{msg.summary || msg.content.slice(0, 60)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
