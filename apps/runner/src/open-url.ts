/**
 * Open a URL in the person's default browser, on every platform buildd runs on.
 *
 * Loaded by `buildd login`, so it imports nothing (client installs ship only
 * the files login.ts and the agent plugin installer reach; install.sh lists them).
 */

/** The command that opens `url` on `platform`. */
export function browserOpenCommand(url: string, platform: string = process.platform): string[] {
  if (platform === 'darwin') return ['open', url];
  // Not `cmd /c start`: cmd re-parses the line and splits a query string at its `&`s.
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url];
  return ['xdg-open', url];
}

type Spawn = (cmd: string[]) => { exited: Promise<number> };

const defaultSpawn: Spawn = cmd => Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });

/** Open `url`; false when no browser could be started, so the caller can print the URL instead. */
export async function openInBrowser(url: string, platform: string = process.platform, spawn: Spawn = defaultSpawn): Promise<boolean> {
  try {
    return (await spawn(browserOpenCommand(url, platform)).exited) === 0;
  } catch {
    return false;
  }
}
