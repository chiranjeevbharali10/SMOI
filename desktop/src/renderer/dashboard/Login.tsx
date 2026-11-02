import { useState, type FormEvent } from 'react';
import type { SessionStatus } from '../../shared/bridge';
import { Face } from './Face';

const api = () => window.smoiDashboard;

/** Sign in, or create an account. Errors are the API client's plain messages. */
export function Login({ onSignedIn }: { onSignedIn: (s: SessionStatus) => void }) {
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = mode === 'signIn' ? await api().signIn(email, password) : await api().register(email, password);
    setBusy(false);
    if (r.ok) onSignedIn(r.value);
    else setError(r.error.message);
  };

  const switchMode = () => {
    setMode(mode === 'signIn' ? 'register' : 'signIn');
    setError(null);
  };

  return (
    <main className="main">
      <form className="card login" onSubmit={submit} aria-labelledby="login-title">
        <h2 id="login-title">{mode === 'signIn' ? 'Sign in' : 'Create an account'}</h2>
        <p>
          {mode === 'signIn'
            ? 'Sign in to your SMOI backend to use SMOI Brain.'
            : 'Create an account on your SMOI backend. Passwords are 12 to 72 characters.'}
        </p>
        {error && (
          <div className="banner error" role="alert">
            <Face name="shocked" />
            <span><strong>{mode === 'signIn' ? 'Sign-in failed.' : 'Account not created.'}</strong> {error}</span>
          </div>
        )}
        <label className="field">
          Email
          <input type="email" autoComplete="username" required autoFocus value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} required
                 minLength={mode === 'register' ? 12 : undefined} maxLength={72}
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signIn' ? 'Sign in' : 'Create account'}
        </button>
        <button className="btn" type="button" onClick={switchMode}>
          {mode === 'signIn' ? 'Create an account instead' : 'I already have an account'}
        </button>
      </form>
    </main>
  );
}
