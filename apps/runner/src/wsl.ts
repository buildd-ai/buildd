/**
 * `buildd wsl <command>` on the Windows launcher (buildd.cmd, install.ps1).
 * Living Spec "Windows runner through WSL2: one guided setup" (a0b82b5d).
 *
 *   buildd wsl install [--distro <name>]   wsl-install.ts (part 1)
 *   buildd wsl migrate [--distro <name>] [--undo]   wsl-migrate.ts (part 3)
 */
const COMMANDS: Record<string, () => Promise<{ main: (argv: string[]) => Promise<number> }>> = {
  install: () => import('./wsl-install'),
  migrate: () => import('./wsl-migrate'),
};

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2);
  const load = sub ? COMMANDS[sub] : undefined;
  if (!load) {
    console.error(`Usage: buildd wsl <${Object.keys(COMMANDS).join('|')}> ...`);
    process.exit(sub ? 64 : 0);
  }
  process.exit(await (await load()).main(rest));
}
