import Link from 'next/link';
import Card from '@/components/ui/Card';
import Notice from '@/components/ui/Notice';
import Section from '@/components/ui/Section';
import { TonePill } from '@/components/ui/StatePill';
import type { ConfigSummary, ModelComparison } from '@buildd/core/model-comparison';
import {
  EVIDENCE_NOTICE, NOT_RECORDED, costText, coverageLines, durationText, numericText, rateText, sampleLabel, tokensText, verdictLine,
} from './comparison-view';

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  const unknown = value === NOT_RECORDED;
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={`text-sm ${unknown ? 'text-text-muted' : 'text-text-primary font-medium'} break-words`}>{value}</dd>
      {detail ? <dd className="text-xs text-text-muted break-words">{detail}</dd> : null}
    </div>
  );
}

function ConfigCard({ c, min }: { c: ConfigSummary; min: number }) {
  const sample = sampleLabel(c.sampleStatus, min);
  const q = rateText(c.quality);
  const d = rateText(c.delivery);
  const lat = numericText(c.latencyMs, durationText);
  const inTok = numericText(c.inputTokens, tokensText);
  const outTok = numericText(c.outputTokens, tokensText);
  const cost = costText(c.cost);
  const gaps = coverageLines(c);
  const taskLinks = c.links.filter((l) => l.taskId).slice(0, 5);
  return (
    <Card as="article" data-testid="comparison-config" className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary break-words min-w-0">{c.identity.model ?? 'Model not recorded'}</h3>
        <TonePill tone={sample.tone} title={sample.title}>{sample.label}</TonePill>
      </div>
      <p className="text-xs text-text-muted break-words">
        {c.identity.endpointKind}, {c.identity.modelVersion ?? 'version not recorded'}, {c.identity.quantization ?? 'quantization not recorded'}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
        <Fact label="Attempts" value={String(c.attempts)} detail={`${c.terminal.completed} completed, ${c.terminal.failed} failed`} />
        <Fact label="Quality" value={q.value} detail={q.detail} />
        <Fact label="Delivered" value={d.value} detail={d.detail} />
        <Fact label="Time to finish" value={lat.value} detail={lat.detail} />
        <Fact label="Input tokens" value={inTok.value} detail={inTok.detail} />
        <Fact label="Output tokens" value={outTok.value} detail={outTok.detail} />
        <Fact label="Known cost" value={cost.value} detail={cost.detail} />
      </dl>
      {gaps.length > 0 && (
        <p className="text-xs text-text-muted" data-testid="comparison-coverage">{gaps.join('. ')}.</p>
      )}
      {taskLinks.length > 0 && (
        <p className="text-xs text-text-secondary flex flex-wrap gap-x-3 gap-y-1">
          {taskLinks.map((l) => (
            <Link key={l.workerId} href={`/app/tasks/${l.taskId}`} className="underline underline-offset-2 py-1">
              Task {String(l.taskId).slice(0, 8)}
            </Link>
          ))}
        </p>
      )}
    </Card>
  );
}

export default function ModelComparisonView({ data }: { data: ModelComparison }) {
  const min = data.evidence.minResolved;
  const short = (k: string) => k.split(' · ')[0];
  return (
    <div className="space-y-8" data-testid="model-comparison">
      <Notice tone="info" title={EVIDENCE_NOTICE.title} data-testid="comparison-evidence">
        {EVIDENCE_NOTICE.body}
      </Notice>

      {data.configs.length === 0 ? (
        <p className="text-sm text-text-muted" data-testid="comparison-empty">No attempts match these filters.</p>
      ) : (
        <Section title="Models and setups" count={data.configs.length}>
          <p className="text-sm text-text-secondary mb-3">
            {data.totals.attempts} attempts. A rate needs {min} attempts with a recorded review, CI or merge result before it counts as more than a hint.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {data.configs.map((c) => <ConfigCard key={c.key} c={c} min={min} />)}
          </div>
        </Section>
      )}

      {data.comparisons.length > 0 && (
        <Section title="Quality against the most-measured setup">
          <ul className="space-y-2" data-testid="comparison-pairs">
            {data.comparisons.map((p) => (
              <li key={`${p.a}|${p.b}`} className="text-sm text-text-secondary break-words">
                {verdictLine(p.verdict, short(p.a), short(p.b), 'quality')}
                {p.interval && p.difference !== null
                  ? ` Gap ${Math.round(p.difference * 100)} points (${Math.round(p.interval.lower * 100)} to ${Math.round(p.interval.upper * 100)}).`
                  : ` ${p.nA} and ${p.nB} attempts with a recorded result; ${min} each are needed.`}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Same task, different models">
        <p className="text-sm text-text-muted mb-2">{data.matched.note}</p>
        {data.matched.pairs.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="matched-empty">No task has a recorded result under two setups.</p>
        ) : (
          <ul className="space-y-2" data-testid="matched-pairs">
            {data.matched.pairs.map((m) => (
              <li key={`${m.a}|${m.b}`} className="text-sm text-text-secondary break-words">
                {short(m.a)} and {short(m.b)}: {m.pairs} tasks, {m.aOnlySupported + m.bOnlySupported} with different results. {verdictLine(m.verdict, short(m.a), short(m.b), 'these setups')}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-text-muted mt-2">{data.evidence.controlled.note}</p>
      </Section>

      <Section title="Public benchmark scores">
        <p className="text-sm text-text-muted mb-2">{data.priors.note}</p>
        {data.priors.entries.length === 0 ? (
          <p className="text-sm text-text-muted" data-testid="priors-empty">No benchmark scores are listed for these models.</p>
        ) : (
          <ul className="space-y-1" data-testid="priors-list">
            {data.priors.entries.map((p) => (
              <li key={`${p.model}|${p.benchmark}`} className="text-sm text-text-secondary">{p.model}: {p.benchmark} {p.score} ({p.source})</li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
