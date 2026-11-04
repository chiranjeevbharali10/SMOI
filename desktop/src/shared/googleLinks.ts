/**
 * Which links SMOI opens from its Google features: only Google's own sites over https. Email and
 * event text is untrusted, so a link that came from it could point anywhere; SMOI's own "Open in
 * Gmail" and "Open" links are built by the backend and checked again here before opening.
 *
 * Pure; tested in test/googleDesktop.test.ts.
 */
const ALLOWED_HOSTS = new Set(['accounts.google.com', 'mail.google.com', 'calendar.google.com', 'www.google.com']);

export function safeGoogleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}
