/** Registration names are hints, never proof of an app's identity. */
export function isLoopbackHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

// NFKD covers fullwidth/mathematical letters; this skeleton also folds common
// Greek/Cyrillic homoglyphs, invisible separators and ASCII digit lookalikes.
function nameSkeleton(name: string): string {
  const confusables: Record<string, string> = {
    'а': 'a', 'α': 'a', 'с': 'c', 'ϲ': 'c', 'ԁ': 'd', 'е': 'e', 'ε': 'e',
    'і': 'i', 'ι': 'i', 'ӏ': 'l', 'ⅼ': 'l', 'υ': 'u', 'ս': 'u', 'ь': 'b',
    'в': 'b', 'ԃ': 'd', 'i': 'l', '|': 'l', '1': 'l', '0': 'o', 'о': 'o', 'ο': 'o', 'ς': 'c',
  };
  return [...name.normalize('NFKD').toLowerCase()]
    .map(c => confusables[c] ?? c).join('').replace(/i/g, 'l').replace(/[^a-z0-9]/g, '');
}

export function reservedNameAllowed(name: string | undefined, redirectUris: string[]): boolean {
  const skeleton = nameSkeleton(name ?? '');
  const reserved = ['claude', 'claudecode', 'buildd', 'builddcli']
    .find(candidate => nameSkeleton(candidate) === skeleton);
  if (!reserved) return true;
  return redirectUris.every(uri => {
    const url = new URL(uri);
    if (reserved === 'claudecode' || reserved === 'builddcli') {
      return ['http:', 'https:'].includes(url.protocol) && isLoopbackHost(url.hostname);
    }
    const hosts = reserved === 'claude' ? ['claude.ai', 'claude.com'] : ['buildd.dev'];
    return url.protocol === 'https:' && hosts.includes(url.hostname);
  });
}
