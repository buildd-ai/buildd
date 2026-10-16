/** Frozen selection evidence. Counts describe tasks at creation, not today's repo. */
export interface TaskEstimateEvidence {
  cutoff: string;
  /** Normalized prior kind when the estimate froze, before later task edits. */
  kind?: string | null;
  history: { total: number; completedWork: number; eligible: number; excluded: Record<string, number> } | null;
  neighbours: { retrieved: number; used: number; reason: string | null };
  clusters: { available: number; used: number; reason: string | null };
  unavailable: string[];
  modelCutoffs?: { prior: string | null; clusters: string | null };
  bucket?: { value: string | null; timing: 'estimate_freeze' };
}
export interface TaskEstimateExplanationPayload {
  sources: Array<{ source: 'neighbours' | 'clusters' | 'prior'; n: number; weight: number }>;
  clusterLabel: string | null;
  priorWeight: number;
  /** Legacy compatibility only. Consumers format the structured fields. */
  summary: string;
  evidence?: TaskEstimateEvidence;
}
export type EstimateCalibration = 'passed' | 'failed' | 'unknown';
export interface TaskEstimatePayload {
  estimatorVersion: string;
  p50Minutes: number; p80Minutes: number;
  p50Tokens: number; p80Tokens: number;
  expectedRepairs: number;
  explanation: TaskEstimateExplanationPayload;
  calibration?: EstimateCalibration;
}
export interface TaskEstimateDisplay {
  formatVersion: 'estimate-display-v1';
  estimatorVersion: string;
  range: { lowerMinutes: number; upperMinutes: number } | null;
  headline: string;
  provenance: string;
  breakdown: string;
  indicative: boolean;
}

export function compactEstimateTokens(n: number): string {
  const unit = n >= 999_995 ? 1_000_000 : n >= 999.995 ? 1_000 : 1;
  return `${Number((n / unit).toFixed(2))}${unit === 1_000_000 ? 'M' : unit === 1_000 ? 'k' : ''}`;
}

/** One display projection for headline and detail; never parse generated prose. */
export function formatTaskEstimate(r: TaskEstimatePayload): TaskEstimateDisplay {
  const sources = r.explanation.sources.filter(s => s.weight > 0 && s.n > 0);
  const local = sources.filter(s => s.source !== 'prior');
  // Sources overlap; do not sum their n as if they were distinct observations.
  const localN = Math.max(0, ...local.map(s => s.n));
  const indicative = r.calibration !== 'passed' || localN < 10 || r.explanation.priorWeight >= 0.5;
  // Fewer than three observations or a >20x spread cannot support a useful displayed range.
  const supported = sources.some(s => s.n >= 3) &&
    Number.isFinite(r.p50Minutes) && Number.isFinite(r.p80Minutes) &&
    r.p50Minutes > 0 && r.p80Minutes >= r.p50Minutes && r.p80Minutes / r.p50Minutes <= 20;
  const step = indicative ? (r.p80Minutes < 60 ? 5 : r.p80Minutes < 180 ? 15 : 30) :
    r.p80Minutes < 10 ? 1 : r.p80Minutes < 60 ? 5 : r.p80Minutes < 180 ? 15 : 30;
  const lowerMinutes = Math.floor((r.p50Minutes + 1e-6) / step) * step;
  const upperMinutes = Math.max(lowerMinutes + step, Math.ceil((r.p80Minutes - 1e-6) / step) * step);
  const range = supported ? { lowerMinutes, upperMinutes } : null;
  const headline = !range ? 'Estimate unavailable' : lowerMinutes === 0 ? `Up to ${upperMinutes} min` : `About ${lowerMinutes}–${upperMinutes} min`;
  const evidence = r.explanation.evidence;
  const h = evidence?.history;
  const localUnavailable = evidence?.unavailable.some(s => s.startsWith('neighbour') || s === 'cluster evidence') ||
    evidence?.neighbours.reason === 'unavailable' || evidence?.clusters.reason === 'unavailable';
  const provenance = !supported ? 'Not enough comparable evidence for a useful range.' : local.length > 0 ?
    (localN < 10 ? 'Based on limited comparable tasks in this repo.' : 'Based on comparable tasks in this repo.') :
    h?.completedWork === 0 ? 'Based on similar tasks across Buildd. Estimates will improve as this repo builds history.' :
    localUnavailable ? 'Based on similar tasks across Buildd; comparable repo evidence was unavailable.' :
    h && h.completedWork > 0 ? 'Based on similar tasks across Buildd; limited comparable history in this repo.' :
    'Based on similar tasks across Buildd; comparable repo history is unavailable.';
  const tokens = supported && Number.isFinite(r.p50Tokens) && Number.isFinite(r.p80Tokens) && r.p50Tokens > 0 && r.p80Tokens >= r.p50Tokens ?
    ` · ${compactEstimateTokens(r.p50Tokens)}–${compactEstimateTokens(r.p80Tokens)} tokens` : '';
  const sourceLabels = { neighbours: 'Comparable repo tasks', clusters: 'Repo area tasks', prior: 'Tasks across Buildd' };
  const detail = sources.map(s => `${sourceLabels[s.source]}: ${Number(s.n.toFixed(1))} (${Math.round(s.weight * 100)}%)`).join('; ');
  const calibration = r.calibration === 'passed' ? 'Calibration verified' : r.calibration === 'failed' ? 'Calibration below target' : 'Calibration not verified';
  return { formatVersion: 'estimate-display-v1', estimatorVersion: r.estimatorVersion, range, headline, provenance,
    breakdown: `${headline}${tokens} · ${r.estimatorVersion}. ${calibration}.${detail ? ` ${detail}.` : ''}`, indicative };
}
