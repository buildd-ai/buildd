const dir = process.env.CANDIDATE_DIR!;
const { toBoardTaskInput } = await import(`${dir}/src/board-input.ts`);
const { toHomeCardInput } = await import(`${dir}/src/home-cards.ts`);
const { buildBoardCells } = await import(`${dir}/src/cells.ts`);
const { overviewProgress } = await import(`${dir}/src/overview.ts`);

const bad: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) bad.push(`${name}: got ${g}, want ${w}`);
};
const base = { status: 'in_progress' };
const t = (id: string, title: string, extra: object = {}) => ({ id, title, ...base, ...extra });
const labels = (xs: { label: string }[]) => xs.map((c) => c.label);

for (const [name, conv] of [['board', toBoardTaskInput], ['home', toHomeCardInput]] as const) {
  const mk = (id: string, title: string, extra: object = {}) => conv(t(id, title, extra));
  eq(`${name}: context from context`, mk('a', 'a', { context: { finalVerification: {} } }).context, { finalVerification: {} });
  eq(`${name}: context from digest`, mk('a', 'a', { contextDigest: { specCriterionCheck: {} } }).context, { specCriterionCheck: {} });
  eq(`${name}: context wins`, mk('a', 'a', { context: { x: 1 }, contextDigest: { y: 2 } }).context, { x: 1 });
  eq(`${name}: neither is null`, mk('a', 'a').context, null);
  eq(`${name}: explicit null digest`, mk('a', 'a', { contextDigest: null }).context, null);

  const cells = buildBoardCells([
    mk('1', 'first'),
    mk('2', 'Verify everything', { context: { finalVerification: {} } }),
    mk('3', 'second'),
    mk('4', 'plain title', { contextDigest: { specCriterionCheck: {} } }),
    mk('5', 'third'),
  ]);
  eq(`${name}: cells`, labels(cells), ['first', 'second', 'third']);
  eq(`${name}: progress`, overviewProgress(cells), { done: 0, total: 3 });

  const titled = buildBoardCells([mk('6', '[final verification] looks like a check but is not')]);
  eq(`${name}: title alone is not a marker`, labels(titled), ['[final verification] looks like a check but is not']);
}

eq('home trims titles', toHomeCardInput(t('h', '  padded  ')).title, 'padded');
eq('board keeps titles', toBoardTaskInput(t('b', '  padded  ')).title, '  padded  ');
eq('status passes through', toBoardTaskInput(t('b', 'x', { status: 'completed' })).status, 'completed');

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
