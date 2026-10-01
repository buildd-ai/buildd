/**
 * The guided spec-authoring interview (docs/design/workspace-onboarding.md §4),
 * defined once so the dashboard wizard and the packaged skill ask the same
 * questions, re-ask the same vague answers, and hand the same answer shape to
 * `POST /api/workspaces/[id]/onboarding/spec`.
 *
 * Pure: no IO. The answer -> spec-markdown mapper lives in
 * `packages/core/onboarding-spec.ts` and imports its types and rules from here.
 */

export const INTERVIEW_QUESTION_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'] as const;
export type InterviewQuestionId = (typeof INTERVIEW_QUESTION_IDS)[number];

/** Where an answer goes. Q8 never reaches the spec: it feeds the merge-policy owner decision. */
export type InterviewTarget = 'spec' | 'merge-policy';

export interface InterviewQuestion {
  id: InterviewQuestionId;
  prompt: string;
  /** `capability` questions are asked once per Q2 item; `product` questions once. */
  scope: 'product' | 'capability';
  /** The `SpecInterviewAnswers` field(s) the answer is stored in. */
  answerField: string;
  target: InterviewTarget;
  /** What the answer becomes. */
  maps: string;
}

export const ONBOARDING_INTERVIEW: readonly InterviewQuestion[] = [
  {
    id: 'Q1',
    prompt: 'In one or two sentences, what is this product and who uses it?',
    scope: 'product',
    answerField: 'title, description',
    target: 'spec',
    maps: 'title and summary (one sentence, present tense, states what MUST hold)',
  },
  {
    id: 'Q2',
    prompt: 'List the 3-7 things it must do (verbs, not features).',
    scope: 'product',
    answerField: 'capabilities[].name',
    target: 'spec',
    maps: 'one block (capability) per item; the first is the primary capability',
  },
  {
    id: 'Q3',
    prompt: 'For each: what must always be true, whatever the input?',
    scope: 'capability',
    answerField: 'capabilities[].invariants',
    target: 'spec',
    maps: 'invariants, each a falsifiable predicate; vague answers are re-asked, "should"/"may" are rewritten to MUST',
  },
  {
    id: 'Q4',
    prompt: 'For each: give one example that works and one that must be rejected.',
    scope: 'capability',
    answerField: 'capabilities[].accepted, capabilities[].rejected',
    target: 'spec',
    maps: 'acceptance criteria (GIVEN/WHEN/THEN); the rejected example is the error-path criterion; at least 3 per block',
  },
  {
    id: 'Q5',
    prompt: 'Where in the repo does this live? (pre-filled from a scan; the owner confirms)',
    scope: 'capability',
    answerField: 'capabilities[].codePaths',
    target: 'spec',
    maps: 'code surface; only paths that exist in the repo are kept',
  },
  {
    id: 'Q6',
    prompt: 'What is explicitly not part of this?',
    scope: 'product',
    answerField: 'outOfScope',
    target: 'spec',
    maps: 'out of scope',
  },
  {
    id: 'Q7',
    prompt: 'How would you know it works today? (tests, a command, a manual check)',
    scope: 'product',
    answerField: 'verification',
    target: 'spec',
    maps: 'verified_by when a real test path exists; otherwise nothing is claimed and the status stays draft',
  },
  {
    id: 'Q8',
    prompt: 'Anything that must never change without you?',
    scope: 'product',
    answerField: 'protectedAreas',
    target: 'merge-policy',
    maps: 'the merge-policy owner decision (risk classes), not the spec',
  },
];

/** Upper bound from Q2; a spec with more capabilities is usually several specs. */
export const MAX_SPEC_CAPABILITIES = 7;
/** Spec format rule 1. */
export const MIN_ACCEPTANCE_CRITERIA_PER_BLOCK = 3;

/** One GIVEN/WHEN/THEN example. `given` is optional: a precondition-free example is valid. */
export interface SpecExample {
  given?: string;
  when: string;
  then: string;
}

export interface SpecCapabilityAnswers {
  /** Q2: a verb phrase, e.g. "charge a cart exactly once". */
  name: string;
  /** Q3: falsifiable predicates that hold whatever the input. */
  invariants: string[];
  /** Q4: an example that works. */
  accepted: SpecExample;
  /** Q4: an example that must be rejected (becomes the error-path criterion). */
  rejected: SpecExample;
  /** Q5: repo paths; only those that exist are kept. */
  codePaths?: string[];
}

export interface SpecInterviewAnswers {
  /** Q1: the product's name. */
  title: string;
  /** Q1: what it is and who uses it, one or two sentences. */
  description: string;
  /** Q2-Q5: 1 to MAX_SPEC_CAPABILITIES entries, primary first. */
  capabilities: SpecCapabilityAnswers[];
  /** Q6 */
  outOfScope?: string[];
  /** Q7: test paths, commands or manual checks; only existing test paths reach `verified_by`. */
  verification?: string[];
  /** Q8: not rendered in the spec. */
  protectedAreas?: string[];
  /** Optional frontmatter inputs the interview does not ask for. */
  domain?: string;
}

export interface InterviewIssue {
  /** Dotted path into the answers, e.g. `capabilities[1].invariants[0]`. */
  path: string;
  /** Phrased so a wizard or an agent can re-ask the question with it. */
  message: string;
}

const VAGUE =
  /\b(etc\.?|and so on|and more|properly|appropriately|as appropriate|as needed|user[- ]friendly|intuitive|seamless(?:ly)?|works? well|robust|reasonable|various)\b/i;

const MIN_PREDICATE_CHARS = 10;

/** Why an answer is too vague to be falsifiable, or `null` when it is specific enough. */
export function findVagueness(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_PREDICATE_CHARS) return 'too short to be a checkable statement; say what exactly must be true';
  const m = VAGUE.exec(trimmed);
  if (m) return `"${m[0]}" cannot be checked; replace it with the concrete condition`;
  return null;
}

/**
 * "should"/"may" are banned by the spec format (rule 2). The owner's wording is
 * kept otherwise; these become MUST / MUST NOT.
 */
export function rewriteModals(text: string): { text: string; changed: boolean } {
  const out = text
    .replace(/\b(?:should not|shouldn't|may not)\b/gi, 'MUST NOT')
    .replace(/\b(?:should|may)\b/gi, 'MUST');
  return { text: out, changed: out !== text };
}

const str = (v: unknown): v is string => typeof v === 'string';
const present = (v: unknown): v is string => str(v) && v.trim().length > 0;

function checkExample(ex: unknown, path: string, label: string, issues: InterviewIssue[]): void {
  if (!ex || typeof ex !== 'object') {
    issues.push({ path, message: `Give the ${label} example as { given?, when, then }.` });
    return;
  }
  const e = ex as Record<string, unknown>;
  if (e.given !== undefined && !str(e.given)) issues.push({ path: `${path}.given`, message: 'given must be text.' });
  for (const k of ['when', 'then'] as const) {
    if (!present(e[k])) issues.push({ path: `${path}.${k}`, message: `The ${label} example needs a ${k}.` });
  }
  if (present(e.then)) {
    const vague = findVagueness(e.then);
    if (vague) issues.push({ path: `${path}.then`, message: `The ${label} example's result is vague: ${vague}.` });
  }
}

function checkStrings(v: unknown, path: string, issues: InterviewIssue[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((i) => !str(i))) issues.push({ path, message: 'Must be a list of text entries.' });
}

/** Structural and vagueness checks over an untrusted answers object. Empty list = ready to render. */
export function validateInterviewAnswers(raw: unknown): InterviewIssue[] {
  const issues: InterviewIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ path: '', message: 'answers must be an object.' }];
  }
  const a = raw as Record<string, unknown>;

  if (!present(a.title)) issues.push({ path: 'title', message: 'Q1: name the product.' });
  if (!present(a.description)) issues.push({ path: 'description', message: 'Q1: say what the product is and who uses it.' });
  if (a.domain !== undefined && !present(a.domain)) issues.push({ path: 'domain', message: 'domain must be text.' });

  const caps = a.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) {
    issues.push({ path: 'capabilities', message: 'Q2: list at least one thing the product must do.' });
  } else {
    if (caps.length > MAX_SPEC_CAPABILITIES) {
      issues.push({
        path: 'capabilities',
        message: `Q2: ${caps.length} capabilities is more than one spec holds; keep ${MAX_SPEC_CAPABILITIES} and spec the rest separately.`,
      });
    }
    caps.forEach((c, i) => {
      const p = `capabilities[${i}]`;
      if (!c || typeof c !== 'object') {
        issues.push({ path: p, message: 'Each capability must be an object.' });
        return;
      }
      const cap = c as Record<string, unknown>;
      if (!present(cap.name)) issues.push({ path: `${p}.name`, message: 'Q2: name what it must do, as a verb.' });
      const inv = cap.invariants;
      if (!Array.isArray(inv) || inv.length === 0 || inv.some((x) => !present(x))) {
        issues.push({ path: `${p}.invariants`, message: 'Q3: give at least one thing that must always be true.' });
      } else {
        inv.forEach((x: string, j) => {
          const vague = findVagueness(x);
          if (vague) issues.push({ path: `${p}.invariants[${j}]`, message: `Q3: ${vague}.` });
        });
      }
      checkExample(cap.accepted, `${p}.accepted`, 'working', issues);
      checkExample(cap.rejected, `${p}.rejected`, 'rejected', issues);
      checkStrings(cap.codePaths, `${p}.codePaths`, issues);
    });
  }

  checkStrings(a.outOfScope, 'outOfScope', issues);
  checkStrings(a.verification, 'verification', issues);
  checkStrings(a.protectedAreas, 'protectedAreas', issues);
  return issues;
}
