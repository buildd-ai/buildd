// Isolated doctor stand-in: no runner state, credentials or external commands.
const mode = process.argv[2];
console.log('Diagnostic report');
if (mode === 'block') {
  console.log('BLOCKING');
  const end = Date.now() + 2000;
  while (Date.now() < end) {} // Deliberately block only the child's event loop.
} else if (mode === 'timeout') {
  console.error('repair stalled');
  setInterval(() => {}, 1000);
} else if (mode === 'signal') {
  console.error('repair interrupted');
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'crash') {
  console.error('repair crashed');
  process.exit(2);
} else if (mode === 'fix' || mode === 'diagnostic') {
  console.log('\x1b[1mAuto-fixes:\x1b[0m\n  ✓ fixture repaired');
  process.exit(mode === 'diagnostic' ? 1 : 0);
}
