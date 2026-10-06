/**
 * install.sh's hint for Chromium's system libraries, run for real.
 *
 * When Playwright installs Chromium without `--with-deps`, Linux may still be
 * missing shared libraries, so the installer prints the apt line to fix it. On
 * macOS there is nothing to install and no apt: the fresh-user walkthrough on a
 * Mac printed "Ubuntu/Debian: sudo apt-get install …" anyway.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'path';

const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();
const BEGIN = '# --- chromium deps hint: begin ---';
const END = '# --- chromium deps hint: end ---';

function hint(os: string): string {
  expect(installSh).toContain(BEGIN);
  const block = installSh.slice(installSh.indexOf(BEGIN), installSh.indexOf(END) + END.length);
  const r = Bun.spawnSync(['bash', '-c', `YELLOW=''; NC=''\n${block}\nchromium_deps_hint "${os}"\n`]);
  expect(r.exitCode).toBe(0);
  return new TextDecoder().decode(r.stdout);
}

describe('install.sh Chromium system-library hint', () => {
  test('Linux gets the apt line', () => {
    expect(hint('Linux')).toContain('apt-get install');
  });

  test('macOS gets no apt line', () => {
    expect(hint('Darwin')).not.toContain('apt');
    expect(hint('Darwin')).not.toContain('Ubuntu');
  });

  test('the installer calls it with the real OS', () => {
    expect(installSh).toContain('chromium_deps_hint "$(uname -s)"');
    // The only apt line left is inside the hint.
    const outside = installSh.replace(installSh.slice(installSh.indexOf(BEGIN), installSh.indexOf(END)), '');
    expect(outside).not.toContain('apt-get install -y libatk');
  });
});
