// Concatenates src/*.ts into out/bundle.js. One build at a time: out/.lock
// holds the pid of the build in progress. Run from the repository root.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';

const LOCK = 'out/.lock';

function acquire() {
  mkdirSync('out', { recursive: true });
  if (existsSync(LOCK)) {
    console.error('build already running');
    process.exit(1);
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
