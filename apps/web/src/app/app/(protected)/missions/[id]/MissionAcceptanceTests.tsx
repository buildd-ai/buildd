import { testsByCheck, type AcceptanceTest } from '@/lib/specs/acceptance-gate';

const WORDS: Record<string, string> = { fail: 'fails, as wanted', pass: 'passes already', inconclusive: 'inconclusive' };

/** The tests the mission added, grouped by the check each covers (spec 1dc6cc39 R-79). */
export default function MissionAcceptanceTests({ tests }: { tests: readonly AcceptanceTest[] }) {
  if (tests.length === 0) return null;
  return (
    <section data-testid="mission-acceptance-tests" className="text-body text-text-secondary">
      <h3 className="font-semibold text-text-primary">Tests added</h3>
      <ul className="mt-1 space-y-1">
        {testsByCheck(tests).map((g) => (
          <li key={g.checkId} data-testid="acceptance-check">
            <span className="font-mono text-meta text-text-muted">{g.checkId}</span>
            <ul>
              {g.tests.map((t) => (
                <li key={t.name}>{t.name} <span className="text-meta text-text-muted">{t.startingResult ? WORDS[t.startingResult] : 'not run yet'}</span></li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
