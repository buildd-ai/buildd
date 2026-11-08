const lines: string[] = [];

/** The only way a command prints: callers (and tests) collect the lines with drain(). */
export function out(line: string): void {
  lines.push(line);
}

export function drain(): string[] {
  return lines.splice(0, lines.length);
}
