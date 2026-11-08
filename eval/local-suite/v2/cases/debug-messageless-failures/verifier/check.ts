const dir = process.env.CANDIDATE_DIR!;
const m = await import(`${dir}/src/patterns.ts`);
const { detectRepeated, EMPTY_SIGNATURE } = m;

const bad: string[] = [];
const row = (id: string, signature: string, exitCause: string | null) => ({
  workerId: `w-${id}`,
  taskId: `task-${id}`,
  signature,
  exitCause,
});
const many = (n: number, sig: string, cause: string | null, tag = '') =>
  Array.from({ length: n }, (_, i) => row(`${tag}${i}`, sig, cause));
const count = (rows: unknown[]) => detectRepeated(rows).length;
const expectCount = (name: string, rows: unknown[], want: number) => {
  const got = count(rows);
  if (got !== want) bad.push(`${name}: ${got} incident(s), want ${want}`);
};

expectCount('eight messageless, cause unknown', many(8, EMPTY_SIGNATURE, null), 0);
const alternating = Array.from({ length: 4 }, (_, i) =>
  row(`m${i}`, EMPTY_SIGNATURE, i % 2 ? 'code_failure' : 'infra_failure'),
);
expectCount('messageless split across two causes', alternating, 0);
expectCount('three messageless, same cause', many(3, EMPTY_SIGNATURE, 'infra_failure'), 1);
const both = [
  ...many(3, EMPTY_SIGNATURE, 'infra_failure', 'a'),
  ...many(3, EMPTY_SIGNATURE, 'code_failure', 'b'),
];
expectCount('two distinct messageless families', both, 2);
expectCount('named error across three tasks', many(3, 'ECONNRESET', 'infra_failure'), 1);
expectCount('named error across two tasks', many(2, 'ECONNRESET', 'infra_failure'), 0);
expectCount('cancelled messageless', many(5, EMPTY_SIGNATURE, 'cancelled'), 0);

const sameTask = Array.from({ length: 5 }, (_, i) => ({
  ...row('x', 'ECONNRESET', 'infra_failure'),
  workerId: `w${i}`,
}));
expectCount('one task, five workers', sameTask, 0);

const found = detectRepeated(many(3, EMPTY_SIGNATURE, 'infra_failure'))[0];
if (found && found.tasks !== 3) bad.push(`incident counts ${found.tasks} tasks, want 3`);
if (found && found.signature === EMPTY_SIGNATURE) {
  bad.push('the incident cannot be told apart from another messageless family');
}
if (detectRepeated(many(4, 'ECONNRESET', 'infra_failure'), 5).length !== 0) {
  bad.push('explicit minTasks is no longer honoured');
}

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
