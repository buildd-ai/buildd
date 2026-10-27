/**
 * `buildd wsl install [--distro <name>]`, run from PowerShell: set up a runner
 * inside WSL2 by installing WSL and Ubuntu only after confirmation, then running
 * the Linux installer inside the distribution.
 * Living Spec "Windows runner through WSL2: one guided setup" (a0b82b5d), part 1.
 */

export async function main(argv: string[]): Promise<number> {
  const { installWsl, realWslCommand, realWslInteractive } = await import('./wsl-setup');
  const { terminalConfirm } = await import('./runner-hold');
  const { release } = await import('os');

  let distro: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') {
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        distro = argv[++i];
      } else {
        console.error('Usage: buildd wsl install [--distro <name>]');
        return 64;
      }
    } else if (a.startsWith('--distro=')) {
      distro = a.slice('--distro='.length);
    } else if (!a.startsWith('-')) {
      console.error('Usage: buildd wsl install [--distro <name>]');
      return 64;
    } else {
      console.error(`Unknown argument: ${a}\nUsage: buildd wsl install [--distro <name>]`);
      return 64;
    }
  }

  return installWsl(distro, {
    platform: process.platform,
    release: release(),
    run: realWslCommand,
    runInteractive: realWslInteractive,
    confirm: terminalConfirm(),
    out: (line) => console.log(line),
  });
}
