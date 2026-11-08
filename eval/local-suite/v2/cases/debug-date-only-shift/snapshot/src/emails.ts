const EMAIL_RE = /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi;

export function redactEmails(s: string): string {
  return s.replace(EMAIL_RE, 'user@example.test');
}
