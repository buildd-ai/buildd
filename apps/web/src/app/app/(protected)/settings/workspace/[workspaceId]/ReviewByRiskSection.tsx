'use client';

import { useEffect, useState } from 'react';
import { REVIEW_BY_RISK_PATH_AREAS, type ReviewByRiskPathArea, type ReviewByRiskPolicy } from '@buildd/shared';
import { emptyRiskAreas, REVIEW_BY_RISK_AREA_LABEL, REVIEW_BY_RISK_AREA_WHAT } from '@/lib/review-by-risk';

/**
 * Review by risk on the workspace Merge Policy page (spec 62e985a8). Off by
 * default; a person turns it on and lists the paths of the three path areas.
 * While on, an area with no paths says that nothing waits for a person (R-5).
 */

export interface ReviewByRiskDraft {
  enabled: boolean;
  /** One path per line, per area. */
  paths: Record<ReviewByRiskPathArea, string>;
}

export function draftOf(policy: ReviewByRiskPolicy | null | undefined): ReviewByRiskDraft {
  const paths = {} as Record<ReviewByRiskPathArea, string>;
  for (const a of REVIEW_BY_RISK_PATH_AREAS) paths[a] = (policy?.areas?.[a] ?? []).join('\n');
  return { enabled: policy?.enabled === true, paths };
}

/** The stored shape of a draft. */
export function policyOfDraft(d: ReviewByRiskDraft): ReviewByRiskPolicy {
  const areas: NonNullable<ReviewByRiskPolicy['areas']> = {};
  for (const a of REVIEW_BY_RISK_PATH_AREAS) {
    const list = d.paths[a].split('\n').map((p) => p.trim()).filter(Boolean);
    if (list.length) areas[a] = list;
  }
  return { enabled: d.enabled, ...(Object.keys(areas).length ? { areas } : {}) };
}

const TEXTAREA = 'w-full px-3 py-2 font-mono text-base md:text-sm bg-input border border-border-default focus:outline-none focus:border-border-strong';

function EmptyAreaNotes({ policy }: { policy: ReviewByRiskPolicy }) {
  const empty = emptyRiskAreas(policy);
  if (!policy.enabled || !empty.length) return null;
  return (
    <ul className="space-y-1" data-testid="review-by-risk-empty-areas">
      {empty.map((a) => (
        <li key={a} className="text-xs text-status-warning">
          {REVIEW_BY_RISK_AREA_LABEL[a]}: no paths listed. Nothing waits for a person.
        </li>
      ))}
    </ul>
  );
}

/** Read-only view, for someone who cannot change the policy. */
export function ReviewByRiskFacts({ policy }: { policy: ReviewByRiskPolicy | null | undefined }) {
  const p = policy ?? { enabled: false };
  return (
    <div className="space-y-2" data-testid="review-by-risk-facts">
      <p className="text-sm text-text-secondary">
        Review by risk: <span className="text-text-primary">{p.enabled ? 'On' : 'Off'}</span>
      </p>
      {p.enabled && (
        <ul className="space-y-1 text-xs text-text-muted">
          {REVIEW_BY_RISK_PATH_AREAS.map((a) => (
            <li key={a}>
              {REVIEW_BY_RISK_AREA_LABEL[a]}: <span className="font-mono">{(p.areas?.[a] ?? []).join(', ') || 'none'}</span>
            </li>
          ))}
          <li>{REVIEW_BY_RISK_AREA_LABEL.acceptanceTests}: found by AC id and check: line</li>
        </ul>
      )}
      <EmptyAreaNotes policy={p} />
    </div>
  );
}

export function ReviewByRiskFields({ draft, onChange }: { draft: ReviewByRiskDraft; onChange: (d: ReviewByRiskDraft) => void }) {
  const policy = policyOfDraft(draft);
  return (
    <div className="space-y-3" data-testid="review-by-risk-section">
      <div>
        <label className="flex items-center gap-2 text-sm text-text-primary min-h-11">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
            data-testid="review-by-risk-toggle"
          />
          Review by risk
        </label>
        <p className="text-xs text-text-muted">
          Agent PRs into the integration branch merge when green and tested. Risk areas and releases wait for a person.
        </p>
      </div>
      {draft.enabled && (
        <div className="space-y-3">
          {REVIEW_BY_RISK_PATH_AREAS.map((a) => (
            <div key={a} className="space-y-1">
              <label htmlFor={`review-by-risk-${a}`} className="text-sm text-text-primary">{REVIEW_BY_RISK_AREA_LABEL[a]}</label>
              <p className="text-xs text-text-muted">{REVIEW_BY_RISK_AREA_WHAT[a]}. One path per line; end a folder with /.</p>
              <textarea
                id={`review-by-risk-${a}`}
                rows={3}
                value={draft.paths[a]}
                onChange={(e) => onChange({ ...draft, paths: { ...draft.paths, [a]: e.target.value } })}
                className={TEXTAREA}
              />
            </div>
          ))}
          <p className="text-xs text-text-muted">
            {REVIEW_BY_RISK_AREA_LABEL.acceptanceTests}: found by AC id and check: line, so no paths are needed.
          </p>
          <EmptyAreaNotes policy={policy} />
        </div>
      )}
    </div>
  );
}

const SUMMARY_LOAD_FAILED = 'Could not load the release summary.';

interface SummaryResponse {
  required: boolean;
  approved: boolean;
  omitted: number;
  summary: { headSha: string; source: string; target: string };
  lines: string[];
}

/** The release summary waiting for a person, with its Approve button (R-6, R-7). */
export function ReleaseSummaryCard({ workspaceId, canApprove }: { workspaceId: string; canApprove: boolean }) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch(`/api/workspaces/${workspaceId}/release-summary`).catch(() => null);
    if (!res) { setNote(SUMMARY_LOAD_FAILED); return; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setData(null); setNote((body as { error?: string }).error ?? SUMMARY_LOAD_FAILED); return; }
    setNote(null);
    setData(body as SummaryResponse);
  }

  useEffect(() => { void load(); }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approve() {
    if (!data) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/release-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headSha: data.summary.headSha }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNote((body as { error?: string }).error ?? 'Could not approve the summary.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="release-summary" className="space-y-2" data-testid="release-summary-card">
      <h4 className="text-sm font-medium text-text-primary">Release summary</h4>
      {note && <p className="text-xs text-text-muted">{note}</p>}
      {data && (
        <>
          <ul className="space-y-1 text-sm text-text-secondary">
            {data.lines.map((l, i) => <li key={i} className={i === 0 ? 'text-text-primary' : ''}>{l}</li>)}
            {data.omitted > 0 && <li className="text-xs text-text-muted">And {data.omitted} more PRs.</li>}
          </ul>
          {!data.required ? (
            <p className="text-xs text-text-muted">This workspace does not ask for a summary approval before release.</p>
          ) : data.approved ? (
            <p className="text-xs text-status-success" data-testid="release-summary-approved">
              Approved for {data.summary.headSha.slice(0, 7)}. A newer commit needs a new approval.
            </p>
          ) : canApprove ? (
            <button type="button" className="btn min-h-11" onClick={approve} disabled={busy} data-testid="release-summary-approve">
              {busy ? 'Approving…' : `Approve release of ${data.summary.headSha.slice(0, 7)}`}
            </button>
          ) : (
            <p className="text-xs text-text-muted">Waiting for a person with merge permission to approve it.</p>
          )}
        </>
      )}
    </div>
  );
}
