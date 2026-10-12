'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { exclusionNotice, planComposition, type ComposePr, type MissionGroup } from '@buildd/core/release-compose';
import Notice, { type NoticeTone } from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import Section from '@/components/ui/Section';
import { TonePill } from '@/components/ui/StatePill';
import type { ReleaseFlowView } from '@/lib/release/compose-source';
import { checkTone, checkWord, criteriaText, FLOW_STEPS, recordSentence, stepIndex } from './flow-display';

type Post = Record<string, unknown> & { action: string };
interface ActionReply {
  ok?: boolean;
  message?: string;
  error?: string;
  needsConfirmation?: string;
  runUrl?: string | null;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 9) : 'none');

function Steps({ step }: { step: ReleaseFlowView['step'] }) {
  const at = stepIndex(step);
  return (
    <ol data-testid="release-flow-steps" className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-meta">
      {FLOW_STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-text-muted">→</span>}
          {at > i ? (
            <span className="text-status-success">✓ {s.label}</span>
          ) : at === i ? (
            <span
              aria-current="step"
              className="font-semibold text-text-primary"
            >
              {s.label}
            </span>
          ) : (
            <span className="text-text-muted">{s.label}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function PrLinks({ prs }: { prs: ComposePr[] }) {
  return (
    <span className="font-mono">
      {prs.map((p, i) => (
        <span key={p.number}>
          {i > 0 && ' '}
          <a href={p.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">#{p.number}</a>
        </span>
      ))}
    </span>
  );
}

/** A mission group as one hairline row: title, then criteria · checks · PRs. */
function MissionLine({ group, control, note }: { group: MissionGroup; control?: React.ReactNode; note?: React.ReactNode }) {
  const m = group.mission;
  const crit = criteriaText(m.criteria);
  return (
    <div data-testid={`compose-row-${group.key}`} className="flex items-start gap-3 border-b border-border-default py-3 last:border-b-0">
      {control}
      <div className="min-w-0 flex-1">
        <Link href={`/app/missions/${m.id}`} className="text-body text-text-primary underline-offset-2 hover:underline">{m.title}</Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted">
          {crit && <span className="font-mono">{crit}</span>}
          {m.missionPr && <TonePill tone={checkTone(m.missionPr.checks)}>checks {checkWord(m.missionPr.checks)}</TonePill>}
          {m.missionPr?.state === 'open' && <span>{m.missionPr.approved ? 'approved' : 'not approved'}</span>}
          <PrLinks prs={group.prs} />
        </div>
        {note && <div className="mt-1 text-meta text-text-secondary">{note}</div>}
      </div>
    </div>
  );
}

function OtherLine({ pr, control, note }: { pr: ComposePr; control?: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div data-testid={`compose-row-pr:${pr.number}`} className="flex items-start gap-3 border-b border-border-default py-3 last:border-b-0">
      {control}
      <div className="min-w-0 flex-1">
        <span className="text-body text-text-primary">{pr.title}</span>{' '}
        <span className="text-meta text-text-muted"><PrLinks prs={[pr]} /></span>
        {note && <div className="mt-1 text-meta text-text-secondary">{note}</div>}
      </div>
    </div>
  );
}

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="flex h-11 w-11 shrink-0 items-start justify-center pt-0.5 md:h-auto md:w-6">
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--text-primary)]" />
    </span>
  );
}

/** The one L3 card on the page: what happens if you confirm, and the confirm. */
function Confirm({ text, action, pending, onConfirm, onCancel }: { text: string; action: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div data-testid="release-flow-confirm" className="card-decision mt-4 rounded-[var(--radius-card)] p-4">
      <p className="text-body text-text-primary">{text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ink h-11 md:h-9" disabled={pending} onClick={onConfirm}>{action}</button>
        <button type="button" className="btn btn-quiet h-11 md:h-9" disabled={pending} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function ReleaseFlow({ view }: { view: ReleaseFlowView }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(view.defaultSelected));
  const [pending, setPending] = useState<string | null>(null);
  const [reply, setReply] = useState<{ tone: NoticeTone; text: string; runUrl?: string | null } | null>(null);
  const [confirming, setConfirming] = useState<{ text: string; action: string; post: Post } | null>(null);

  const c = view.composition;
  const cand = view.candidate;
  const plan = useMemo(() => planComposition(c, selected), [c, selected]);
  // On the review step, only changes still in the candidate can be left out now.
  const newlyLeftOut = plan.exclusions.filter((e) => !view.leftOut.includes(e.key));

  function toggle(key: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function send(post: Post, label: string) {
    setPending(label);
    setReply(null);
    try {
      const res = await fetch('/api/releases/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: view.workspace.id, ...post }),
      });
      const body = (await res.json().catch(() => ({}))) as ActionReply;
      if (body.needsConfirmation && !post.confirmed) {
        setConfirming({ text: body.needsConfirmation, action: label, post: { ...post, confirmed: true } });
        return;
      }
      setConfirming(null);
      setReply({ tone: res.ok ? (res.status === 202 ? 'info' : 'ok') : 'err', text: body.message ?? body.error ?? `Request failed (${res.status}).`, runUrl: body.runUrl });
      router.refresh();
    } catch (e) {
      setReply({ tone: 'err', text: e instanceof Error ? e.message : 'Request failed.' });
    } finally {
      setPending(null);
    }
  }

  const leftOutKeys = new Set(view.leftOut);
  const inCandidate = (key: string) => !leftOutKeys.has(key);

  return (
    <div className="flex flex-col">
      <div className="mb-5">
        <h1 className="sr-only">Release</h1>
        <p data-testid="release-flow-lede" className="font-voice text-heading font-medium text-text-primary">{view.lede}</p>
        <div className="mt-2"><Steps step={view.step} /></div>
        <p className="mt-1 text-meta text-text-muted">{view.workspace.name} · {view.sourceBranch} → {view.prodBranch}</p>
      </div>

      {reply && (
        <Notice tone={reply.tone} className="mb-4" data-testid="release-flow-reply" action={reply.runUrl ? { label: 'Workflow run', href: reply.runUrl } : undefined}>
          {reply.text}
        </Notice>
      )}
      {view.truncated && (
        <Notice tone="warn" className="mb-4">GitHub listed only the first 250 commits on {view.sourceBranch}; some changes may be missing from this list.</Notice>
      )}

      {/* ── Release: merged, waiting for production ── */}
      {view.merged && !view.merged.confirmed && (view.step === 'release' || view.step === 'released') && (
        <Section title="Production">
          <div className="text-body text-text-secondary">
            <p>
              <a href={view.merged.url} target="_blank" rel="noreferrer" className="text-text-primary underline-offset-2 hover:underline">v{view.merged.version}</a>{' '}
              merged into {view.prodBranch} as <span className="font-mono">{short(view.merged.mergeSha)}</span>. Production runs{' '}
              <span className="font-mono">{view.merged.deployedSha ? short(view.merged.deployedSha) : 'an unknown SHA'}</span>
              {view.merged.production === 'released' ? ', which contains it.' : ', which does not contain it.'}
            </p>
          </div>
          <div className="mt-4">
            <PrimaryAction data-testid="release-flow-confirm-production" fullWidthOnMobile pending={pending === 'confirm'} disabled={view.merged.production !== 'released' || !!pending} onClick={() => send({ action: 'confirm' }, 'confirm')}>
              Mark v{view.merged.version} released
            </PrimaryAction>
            {view.merged.production !== 'released' && <p className="mt-2 text-meta text-text-muted">Enabled when production reports running {short(view.merged.mergeSha)} or later.</p>}
          </div>
        </Section>
      )}

      {/* ── Review: the frozen candidate ── */}
      {cand && (
        <Section title="Candidate">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
            <dt className="text-text-muted">Version</dt>
            <dd><a href={cand.url} target="_blank" rel="noreferrer" className="text-text-primary underline-offset-2 hover:underline">v{cand.version}</a> <span className="font-mono text-text-muted">#{cand.prNumber}</span></dd>
            <dt className="text-text-muted">Candidate SHA</dt>
            <dd className="font-mono text-text-primary">{short(cand.candidateSha)}</dd>
            <dt className="text-text-muted">Cut from</dt>
            <dd className="font-mono text-text-secondary">{view.sourceBranch}@{short(cand.sourceSha)}</dd>
            {cand.amendment > 0 && (
              <>
                <dt className="text-text-muted">Amended</dt>
                <dd className="text-text-secondary">
                  {cand.amendment} {cand.amendment === 1 ? 'time' : 'times'}, from <span className="font-mono">{short(cand.previousCandidateSha)}</span>
                  {cand.deltaUrl && <> · <a href={cand.deltaUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">what changed</a></>}
                </dd>
              </>
            )}
          </dl>
          {cand.refusal && (
            <Notice tone="err" className="mt-4" title={`Could not leave out ${short(cand.refusal.sha)}`} data-testid="release-flow-refusal">
              Reverting it on the candidate conflicts in {cand.refusal.files.length ? cand.refusal.files.join(', ') : 'files git did not name'}. Nothing changed; the candidate is still {short(cand.candidateSha)}.
            </Notice>
          )}
        </Section>
      )}

      {cand && (
        <Section title="Checks on this SHA" count={cand.verdict.checks.length}>
          <div className="border-t border-border-default">
            {cand.verdict.checks.map((ch) => (
              <div key={ch.name} data-testid={`release-flow-check-${ch.name}`} className="flex items-center justify-between gap-3 border-b border-border-default py-2">
                <span className="min-w-0 truncate text-body text-text-primary">
                  {ch.url ? <a href={ch.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{ch.name}</a> : ch.name}
                  {!ch.required && <span className="ml-2 text-meta text-text-muted">not required</span>}
                </span>
                <TonePill tone={checkTone(ch.state)}>{checkWord(ch.state)}</TonePill>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-b border-border-default py-2">
              <span className="text-body text-text-primary">
                <a href={cand.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">Review</a>
                {cand.verdict.staleApprovals > 0 && <span className="ml-2 text-meta text-text-muted">{cand.verdict.staleApprovals} approval{cand.verdict.staleApprovals === 1 ? '' : 's'} on an earlier SHA, void</span>}
              </span>
              <TonePill tone={cand.verdict.approved ? 'ok' : 'q'}>{cand.verdict.approved ? 'approved on this SHA' : 'not approved on this SHA'}</TonePill>
            </div>
          </div>
          <p className="mt-2 text-meta text-text-muted">Nothing here approves the candidate. A person approves it on GitHub, on this exact SHA.</p>
        </Section>
      )}

      {/* ── Composition: chosen before the cut, frozen after ── */}
      {view.step === 'compose' || cand ? (
        <>
          <Section title={cand ? 'Missions in this candidate' : 'Missions on dev'} count={c.onDev.length}>
            <div className="border-t border-border-default">
              {c.onDev.map((g) => (
                <MissionLine
                  key={g.key}
                  group={g}
                  control={<Check label={`Ship ${g.mission.title}`} checked={selected.has(g.key)} disabled={!inCandidate(g.key) || !!pending} onChange={(v) => toggle(g.key, v)} />}
                  note={!inCandidate(g.key) ? 'Left out of this candidate. dev keeps it for the next release.' : !selected.has(g.key) ? 'Leaving this out reverts its merge on the candidate.' : null}
                />
              ))}
            </div>
          </Section>

          {!cand && (
            <Section title="Ready to include" count={c.ready.length}>
              <div className="border-t border-border-default">
                {c.ready.map((g) => (
                  <MissionLine
                    key={g.key}
                    group={g}
                    note={`Including merges #${g.prs[0].number} into ${view.sourceBranch} through the normal merge checks, before the cut.`}
                    control={
                      <button type="button" className="btn h-11 shrink-0 md:h-8" disabled={!!pending} onClick={() => send({ action: 'include', missionId: g.mission.id }, `include:${g.mission.id}`)}>
                        {pending === `include:${g.mission.id}` ? 'Merging…' : 'Include'}
                      </button>
                    }
                  />
                ))}
              </div>
            </Section>
          )}

          {!cand && (
            <Section title="Not ready" count={c.notReady.length}>
              <div className="border-t border-border-default">
                {c.notReady.map((g) => (
                  <MissionLine key={g.key} group={g} note="Its mission PR needs an approval and passing checks before it can be included." />
                ))}
              </div>
            </Section>
          )}

          <Section title="Other changes" count={c.other.length}>
            <div className="border-t border-border-default">
              {c.other.map((o) => (
                <OtherLine
                  key={o.key}
                  pr={o.pr}
                  control={<Check label={`Ship #${o.pr.number}`} checked={selected.has(o.key)} disabled={!inCandidate(o.key) || !!pending} onChange={(v) => toggle(o.key, v)} />}
                  note={!inCandidate(o.key) ? 'Left out of this candidate.' : null}
                />
              ))}
            </div>
          </Section>

          {c.onDev.length + c.other.length === 0 && !cand && (
            <p className="py-4 text-body text-text-secondary">Nothing on {view.sourceBranch} since the last release.</p>
          )}

          {newlyLeftOut.length > 0 && !confirming && (
            <Notice tone="warn" className="mt-2" data-testid="release-flow-exclusion-notice">{exclusionNotice(newlyLeftOut, cand?.candidateSha ?? null)}</Notice>
          )}

          {confirming && (
            <Confirm text={confirming.text} action={confirming.action} pending={!!pending} onConfirm={() => send(confirming.post, confirming.action)} onCancel={() => setConfirming(null)} />
          )}

          {!confirming && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {!cand && view.step === 'compose' && (
                <PrimaryAction
                  data-testid="release-flow-cut"
                  fullWidthOnMobile
                  pending={pending === 'Cut the candidate'}
                  disabled={!!pending || plan.missionCount + plan.otherCount === 0 || !view.compositionSha}
                  onClick={() => send({ action: 'cut', selected: [...selected], expectedSourceSha: view.compositionSha }, 'Cut the candidate')}
                >
                  Cut the candidate
                </PrimaryAction>
              )}
              {cand && newlyLeftOut.length > 0 && (
                <button
                  type="button"
                  data-testid="release-flow-exclude"
                  className="btn h-11 md:h-10"
                  disabled={!!pending}
                  onClick={() => send({ action: 'exclude', keys: newlyLeftOut.map((e) => e.key), expectedCandidateSha: cand.candidateSha }, 'Leave out and amend')}
                >
                  Leave out and amend
                </button>
              )}
              {cand && newlyLeftOut.length === 0 && (
                <PrimaryAction
                  data-testid="release-flow-release"
                  fullWidthOnMobile
                  pending={pending === 'release'}
                  disabled={!!pending || !cand.verdict.readyToRelease}
                  onClick={() => send({ action: 'release', expectedCandidateSha: cand.candidateSha }, 'release')}
                >
                  Release v{cand.version}
                </PrimaryAction>
              )}
            </div>
          )}
          {!cand && view.compositionSha && (
            <p className="mt-2 text-meta text-text-muted">
              Cut from {view.sourceBranch} at <span className="font-mono">{short(view.compositionSha)}</span>. If {view.sourceBranch} moves first, the cut is refused and this page shows the new list.
            </p>
          )}
          {cand && !cand.verdict.readyToRelease && newlyLeftOut.length === 0 && (
            <p className="mt-2 text-meta text-text-muted">Release is enabled when every required check passed and an approval stands on {short(cand.candidateSha)}.</p>
          )}
        </>
      ) : null}

      <Section title="Record" count={view.record.length}>
        <div className="border-t border-border-default">
          {view.record.map((r) => (
            <div key={r.id} data-testid="release-flow-record-row" className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border-default py-2">
              <span className="min-w-0 text-body text-text-secondary">{recordSentence(r)}</span>
              <time dateTime={r.at} className="font-mono text-meta text-text-muted">{new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
