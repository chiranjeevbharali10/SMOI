import { describe, expect, it } from 'vitest';
import { Session, type Crypto, type Files } from '../src/main/session';

/** A stand-in for safeStorage: reversible, but the output never contains the plain text. */
const crypto = (available: boolean): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a) as Buffer,
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
});

function memoryFiles(): Files & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>();
  return { data, read: (p) => data.get(p) ?? null, write: (p, d) => void data.set(p, d), remove: (p) => void data.delete(p) };
}

const FUTURE = '2099-01-01T00:00:00Z';

describe('session storage', () => {
  it('saves the token encrypted, never in plain text, and restores it', () => {
    const files = memoryFiles();
    const s = new Session('session.bin', crypto(true), files);
    expect(s.signIn('secret-jwt', 'a@b.c', FUTURE).persisted).toBe(true);
    expect(files.data.get('session.bin')!.toString('utf8')).not.toContain('secret-jwt');

    const again = new Session('session.bin', crypto(true), files);
    again.load();
    expect(again.token()).toBe('secret-jwt');
    expect(again.status()).toMatchObject({ signedIn: true, email: 'a@b.c', persisted: true });
  });

  it('without encryption, keeps the token in memory only and says so', () => {
    const files = memoryFiles();
    const s = new Session('session.bin', crypto(false), files);
    const status = s.signIn('secret-jwt', 'a@b.c', FUTURE);
    expect(status).toMatchObject({ signedIn: true, persisted: false });
    expect(s.token()).toBe('secret-jwt');
    expect(files.data.size).toBe(0);
  });

  it('forgets an expired token, in memory and on disk', () => {
    let now = Date.parse('2030-01-01T00:00:00Z');
    const files = memoryFiles();
    const s = new Session('session.bin', crypto(true), files, () => now);
    s.signIn('jwt', 'a@b.c', '2030-01-01T01:00:00Z');
    now += 60 * 60 * 1000;
    expect(s.token()).toBeNull();
    expect(files.data.size).toBe(0);
  });

  it('does not restore an expired or unreadable file', () => {
    const files = memoryFiles();
    files.data.set('session.bin', Buffer.from('garbage'));
    const s = new Session('session.bin', crypto(true), files);
    s.load();
    expect(s.status().signedIn).toBe(false);
    expect(files.data.size).toBe(0);
  });

  it('signing out or a rejected token removes the saved session', () => {
    const files = memoryFiles();
    const s = new Session('session.bin', crypto(true), files);
    s.signIn('jwt', 'a@b.c', FUTURE);
    s.expired();
    expect(s.token()).toBeNull();
    expect(files.data.size).toBe(0);
  });
});
