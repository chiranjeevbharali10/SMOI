/**
 * The signed-in session: the JWT, its expiry and the email it belongs to.
 *
 * The token is saved to disk only encrypted with Electron's safeStorage (Windows DPAPI, tied to
 * the Windows user). If encryption isn't available, the token is kept in memory only and the
 * user is told they will need to sign in again next time. It is never written in plain text.
 *
 * Electron's safeStorage and the file system are passed in, so the rules are unit-tested.
 */
export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface Files {
  read(path: string): Buffer | null;
  write(path: string, data: Buffer): void;
  remove(path: string): void;
}

export interface SessionStatus {
  signedIn: boolean;
  email: string | null;
  expiresAt: string | null;
  /** False when the token lives only in memory, so the next launch asks to sign in again. */
  persisted: boolean;
}

interface Saved {
  token: string;
  email: string;
  expiresAt: string;
}

export class Session {
  private saved: Saved | null = null;
  private persisted = false;
  private listeners: ((s: SessionStatus) => void)[] = [];

  constructor(
    private readonly file: string,
    private readonly crypto: Crypto,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores a saved session if it can be decrypted and hasn't expired. */
  load(): void {
    const data = this.files.read(this.file);
    if (!data) return;
    try {
      if (!this.crypto.isEncryptionAvailable()) throw new Error('no encryption');
      const s = JSON.parse(this.crypto.decryptString(data)) as Saved;
      if (typeof s.token !== 'string' || Date.parse(s.expiresAt) <= this.now()) throw new Error('expired');
      this.saved = s;
      this.persisted = true;
    } catch {
      this.files.remove(this.file); // unreadable or expired: forget it
    }
  }

  signIn(token: string, email: string, expiresAt: string): SessionStatus {
    this.saved = { token, email, expiresAt };
    this.persisted = false;
    if (this.crypto.isEncryptionAvailable()) {
      try {
        this.files.write(this.file, this.crypto.encryptString(JSON.stringify(this.saved)));
        this.persisted = true;
      } catch {
        this.files.remove(this.file);
      }
    }
    return this.changed();
  }

  signOut(): SessionStatus {
    this.saved = null;
    this.persisted = false;
    this.files.remove(this.file);
    return this.changed();
  }

  /** The token, or null if signed out or expired. */
  token(): string | null {
    if (this.saved && Date.parse(this.saved.expiresAt) <= this.now()) this.signOut();
    return this.saved?.token ?? null;
  }

  /** The backend rejected the token. */
  expired(): void {
    if (this.saved) this.signOut();
  }

  status(): SessionStatus {
    this.token(); // drops an expired token
    return {
      signedIn: this.saved != null,
      email: this.saved?.email ?? null,
      expiresAt: this.saved?.expiresAt ?? null,
      persisted: this.persisted,
    };
  }

  onChange(listener: (s: SessionStatus) => void): void {
    this.listeners.push(listener);
  }

  private changed(): SessionStatus {
    const s = this.status();
    this.listeners.forEach((l) => l(s));
    return s;
  }
}
