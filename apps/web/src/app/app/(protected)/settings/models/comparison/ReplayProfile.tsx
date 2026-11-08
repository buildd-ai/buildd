import Card from '@/components/ui/Card';
import Section from '@/components/ui/Section';
import type { ReplayComparison } from '@buildd/core/model-comparison';
import { NOT_RECORDED, REPLAY_EMPTY, SPLIT_LABEL, categoryTitle, durationText, tokensText, v2RateText, verdictLine } from './comparison-view';

/** Controlled replay runs: v1 per-case counts stay as they were; v2 adds a per-category profile. No score, rank or winner. */
export default function ReplayProfile({ replay }: { replay: ReplayComparison }) {
  const hasV2 = replay.v2.configs.length > 0;
  const hasV1 = replay.configs.length > 0;
  return (
    <Section title="Coding evaluation runs" id="replay-profile">
      <p className="text-sm text-text-muted mb-3">{replay.v2.note}</p>
      {!hasV1 && !hasV2 ? <p className="text-sm text-text-muted" data-testid="replay-empty">{REPLAY_EMPTY}</p> : null}

      {hasV2 && (
        <div className="space-y-4" data-testid="v2-profile">
          {replay.v2.configs.map((cfg) => (
            <Card as="article" key={cfg.configId} className="space-y-3 min-w-0">
              <h3 className="text-sm font-semibold text-text-primary break-words">{cfg.configId}</h3>
              {cfg.splits.map((s) => (
                <div key={s.split} className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">{SPLIT_LABEL[s.split] ?? s.split}, {s.runs} runs</p>
                  <ul className="space-y-2">
                    {s.categories.map((c) => {
                      const errs = c.errors.harness + c.errors.infra;
                      const flagText = Object.entries(c.flags).map(([f, n]) => `${f.replace(/_/g, ' ')} ${n}`).join(', ');
                      const d = c.drilldown;
                      const extra = [
                        d.reviewPrecision ? `precision ${v2RateText(d.reviewPrecision).split(' ')[0]}` : null,
                        d.reviewRecall ? `recall ${v2RateText(d.reviewRecall).split(' ')[0]}` : null,
                        d.citations ? `citations ${v2RateText(d.citations).split(' (')[0]}` : null,
                        d.regressionSuccess ? `regression ${v2RateText(d.regressionSuccess).split(' (')[0]}` : null,
                        d.invariants ? `invariants ${v2RateText(d.invariants).split(' (')[0]}` : null,
                        d.retentionByStage.length ? `retention ${d.retentionByStage.map((x) => Math.round(x.mean * 100) + '%').join(' > ')}` : null,
                      ].filter(Boolean).join(', ');
                      return (
                        <li key={c.category} className="text-sm text-text-secondary break-words" data-testid="v2-category">
                          <span className="font-medium text-text-primary">{categoryTitle(c.category)}</span>: {v2RateText(c.rate)}
                          <span className="block text-xs text-text-muted">
                            {c.cases} {c.cases === 1 ? "case" : "cases"}, {c.trials} {c.trials === 1 ? "run" : "runs"}{c.mixedCases ? `, ${c.mixedCases} with mixed trials` : ''}
                            {errs ? `, ${errs} harness or infrastructure errors not counted` : ''}
                            {c.errors.model ? `, ${c.errors.model} model failures` : ''}
                            {c.unscored ? `, ${c.unscored} unscored` : ''}
                            {c.retries ? `, ${c.retries} retries` : ''}
                          </span>
                          <span className="block text-xs text-text-muted">
                            Time {c.latencyMs.median === null ? NOT_RECORDED : durationText(c.latencyMs.median)}, tokens in {c.inputTokens.median === null ? NOT_RECORDED : tokensText(c.inputTokens.median)} out {c.outputTokens.median === null ? NOT_RECORDED : tokensText(c.outputTokens.median)}, peak VRAM {c.peakVramMb.max === null ? NOT_RECORDED : `${c.peakVramMb.max} MiB`}
                          </span>
                          {extra ? <span className="block text-xs text-text-muted">{extra}</span> : null}
                          {flagText ? <span className="block text-xs text-text-muted">Flags: {flagText}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </Card>
          ))}
          {replay.v2.paired.length > 0 && (
            <ul className="space-y-2" data-testid="v2-paired">
              {replay.v2.paired.map((p) => (
                <li key={`${p.split}|${p.a}|${p.b}`} className="text-sm text-text-secondary break-words">
                  {SPLIT_LABEL[p.split] ?? p.split}: {verdictLine(p.verdict, p.a, p.b, 'these setups')}
                  {p.interval && p.difference !== null ? ` Gap ${Math.round(p.difference * 100)} points (${Math.round(p.interval.lower * 100)} to ${Math.round(p.interval.upper * 100)}).` : ` ${p.nA} and ${p.nB} runs on ${p.commonCases} shared cases.`}
                </li>
              ))}
            </ul>
          )}
          {replay.v2.candidates.length > 0 && (
            <div data-testid="v2-candidates">
              <h3 className="text-sm font-semibold text-text-primary mb-1">Conclusions to confirm independently</h3>
              <ul className="space-y-1">
                {replay.v2.candidates.slice(0, 20).map((c) => (
                  <li key={c.runId} className="text-xs text-text-secondary break-words">{c.caseId} on {c.configId}: {c.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {hasV1 && (
        <div className="mt-4 space-y-2" data-testid="v1-replay">
          <h3 className="text-sm font-semibold text-text-primary">Earlier replay suite (v1)</h3>
          <ul className="space-y-1">
            {replay.configs.map((c) => (
              <li key={c.configId} className="text-sm text-text-secondary break-words">
                {c.configId}: {c.cases.reduce((n, x) => n + x.passes, 0)} of {c.cases.reduce((n, x) => n + x.trials, 0)} trials passed on {c.cases.length} cases
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
