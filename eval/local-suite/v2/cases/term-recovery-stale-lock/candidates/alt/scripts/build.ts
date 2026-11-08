// Concatenates src/*.ts into out/bundle.js. One build at a time: out/.lock
// holds the pid of the build in progress. Run from the repository root.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';

const LOCK = 'out/.lock';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquire() {
  mkdirSync('out', { recursive: true });
  if (existsSync(LOCK)) {
    const owner = parseInt(readFileSync(LOCK, 'utf8'), 10);
    if (owner > 0 && alive(owner)) {
      console.error('build already running');
      process.exit(1);
    }
    console.log('removed stale lock');
    unlinkSync(LOCK);
  }
  writeFileSync(LOCK, String(process.pid));
}

function release() {
  if (existsSync(LOCK)) unlinkSync(LOCK);
}

acquire();
try {
  const parts = readdirSync('src')
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `// --- ${f}\n${readFileSync(`src/${f}`, 'utf8')}`);
  writeFileSync('out/bundle.js', `// bundle v1\n${parts.join('\n')}//# end\n`);
  console.log('built out/bundle.js');
} finally {
  release();
}
