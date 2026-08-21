import { useState } from 'react';
import { api, ApiError, type SelfUser } from '../lib/api';

export function Login({ onSignedIn }: { onSignedIn: (user: SelfUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username, password);
      onSignedIn(user);
    } catch (err) {
      // Deliberately vague: never reveal whether the username exists.
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'Incorrect username or password.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Orbit</h1>
        <p className="mt-1 text-xs text-neutral-400">Sign in to join the shared browser session.</p>

        <label className="mt-5 block text-xs font-medium text-neutral-300" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />

        <label className="mt-3 block text-xs font-medium text-neutral-300" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {error && <p className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-md bg-sky-600 px-3 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </div>
  );
}
