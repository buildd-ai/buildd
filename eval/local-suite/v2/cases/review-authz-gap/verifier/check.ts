import { existsSync, readFileSync } from 'node:fs';

// Defects seeded in this case: file, line range in the post-change tree, and
// word groups (each group needs one word) that name the cause. An empty list
// is a clean control: any finding is a false positive.
const DEFECTS: { id: string; file: string; startLine: number; endLine: number; cause: string[][] }[] = [
  { id: "delete-without-owner-check", file: "src/projects.ts", startLine: 27, endLine: 29, cause: [["owner", "authoriz", "permission", "access control", "any user", "any signed", "any logged", "anyone", "privilege", "forbidden", "403", "ownership"]] },
];
const TOLERANCE = 2;

const p = `${process.env.CANDIDATE_DIR}/review.json`;
if (!existsSync(p)) {
  console.error('no review.json');
  process.exit(1);
}
let r: any;
try {
  r = JSON.parse(readFileSync(p, 'utf8'));
} catch {
  console.error('review.json is not valid JSON');
  process.exit(1);
}
if (!r || !Array.isArray(r.findings)) {
  console.error('review.json needs a findings array (empty for a clean change)');
  process.exit(1);
}
const matched = new Set<string>();
const bad: string[] = [];
for (const f of r.findings) {
  if (typeof f?.file !== 'string' || typeof f?.line !== 'number' || typeof f?.description !== 'string') {
    bad.push('malformed finding');
    continue;
  }
  const d = DEFECTS.find(
    (x) =>
      x.file === f.file &&
      f.line >= x.startLine - TOLERANCE &&
      f.line <= x.endLine + TOLERANCE &&
      x.cause.every((g) => g.some((w) => f.description.toLowerCase().includes(w.toLowerCase()))),
  );
  if (!d) bad.push(`false positive: ${f.file}:${f.line}`);
  else if (matched.has(d.id)) bad.push(`duplicate finding for ${d.id}`);
  else matched.add(d.id);
}
for (const d of DEFECTS) if (!matched.has(d.id)) bad.push(`missed defect ${d.id}`);
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
