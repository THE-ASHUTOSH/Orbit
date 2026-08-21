/**
 * Admin drawer: browser health, per-tab detail, user management and the
 * destructive operations. Every action here is also enforced server-side - this
 * panel is a convenience, not the security boundary.
 */
import { useEffect, useState } from 'react';
import type { BrowserState, ServerMetrics } from '@orbit/protocol';
import { api, type SelfUser } from '../lib/api';

interface Props {
  state: BrowserState;
  metrics: ServerMetrics | null;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
}

export function Admin({ state, metrics, onClose, onCloseTab, onCreateTab }: Props) {
  const [users, setUsers] = useState<(SelfUser & { lastSeenAt: number | null })[]>([]);
  const [cookies, setCookies] = useState<{ domain: string; count: number }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', password: '', role: 'user' });

  const refresh = () => {
    void api.users().then((r) => setUsers(r.users)).catch(() => setNotice('Could not load users.'));
    void api.cookies().then((r) => setCookies(r.domains.slice(0, 12))).catch(() => setCookies([]));
  };
  useEffect(refresh, []);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      setNotice(message);
      refresh();
    } catch {
      setNotice('That action failed. Check the server logs.');
    }
  };

  return (
    <aside className="absolute right-0 top-0 z-30 h-full w-full max-w-md overflow-y-auto border-l border-neutral-800 bg-neutral-900 p-4 shadow-2xl">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Admin</h2>
        <button onClick={onClose} className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800">
          close
        </button>
      </header>

      {notice && <p className="mt-3 rounded bg-sky-500/10 px-3 py-2 text-xs text-sky-200">{notice}</p>}

      <Section title="Browser">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
          <Row k="status" v={state.status} />
          <Row k="browserId" v={state.browserId} />
          <Row k="restarts" v={String(state.restarts)} />
          <Row k="tabs" v={`${state.tabs.length} / ${state.limits.maxTabs}`} />
          <Row k="users" v={`${state.users.length} / ${state.limits.maxUsers}`} />
          {metrics && <Row k="cpu" v={`${metrics.cpuPercent}%`} />}
          {metrics && <Row k="memory" v={`${(metrics.rssBytes / 1e9).toFixed(2)} GB`} />}
          {metrics && <Row k="fps" v={String(metrics.framesPerSecond)} />}
          {metrics && <Row k="p95 input" v={`${metrics.p95InputDispatchMs} ms`} />}
          {metrics && <Row k="dropped frames" v={String(metrics.droppedFrames)} />}
        </dl>
        <div className="mt-2 flex gap-2">
          <Danger onClick={() => void act(api.restartBrowser, 'Browser restarting…')}>Restart browser</Danger>
          <button onClick={onCreateTab} className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700">
            New tab
          </button>
        </div>
      </Section>

      <Section title="Tabs">
        <ul className="space-y-1.5">
          {state.tabs.map((t) => (
            <li key={t.tabId} className="rounded border border-neutral-800 p-2 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{t.label || t.title || 'New tab'}</span>
                <button onClick={() => onCloseTab(t.tabId)} className="text-neutral-500 hover:text-red-400">
                  close
                </button>
              </div>
              <div className="truncate font-mono text-neutral-500">{t.url}</div>
              <div className="mt-1 flex gap-2 text-neutral-400">
                <span>{t.tabId}</span>
                <span>{t.width}×{t.height}</span>
                <span>{t.viewers.length} viewer(s)</span>
                <span>{t.loading ? 'loading' : 'idle'}</span>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Users">
        <ul className="space-y-1">
          {users.map((u) => (
            <li key={u.userId} className="flex items-center gap-2 rounded border border-neutral-800 px-2 py-1 text-[11px]">
              <span className="font-medium">{u.username}</span>
              <span className="rounded bg-neutral-800 px-1.5">{u.role}</span>
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => void act(() => api.disconnectUser(u.userId), `${u.username} disconnected.`)}
                  className="text-neutral-400 hover:text-amber-400"
                >
                  disconnect
                </button>
                <button
                  onClick={() => void act(() => api.deleteUser(u.userId), `${u.username} removed.`)}
                  className="text-neutral-400 hover:text-red-400"
                >
                  delete
                </button>
              </span>
            </li>
          ))}
        </ul>

        <form
          className="mt-2 flex flex-wrap gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.createUser(form), `Created ${form.username}.`).then(() =>
              setForm({ username: '', password: '', role: 'user' }),
            );
          }}
        >
          <input
            className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px]"
            placeholder="username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
          />
          <input
            className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px]"
            placeholder="password (8+)"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          <select
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px]"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            <option value="admin">admin</option>
            <option value="user">user</option>
            <option value="viewer">viewer</option>
          </select>
          <button className="rounded bg-sky-600 px-2 py-1 text-[11px] hover:bg-sky-500">add</button>
        </form>
      </Section>

      <Section title="Shared browser state">
        <p className="text-[11px] text-neutral-500">
          Cookie counts per domain. Values are never exposed - they are credentials.
        </p>
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {cookies.map((c) => (
            <li key={c.domain} className="flex justify-between">
              <span className="truncate">{c.domain}</span>
              <span className="text-neutral-500">{c.count}</span>
            </li>
          ))}
          {cookies.length === 0 && <li className="text-neutral-600">no cookies yet</li>}
        </ul>
      </Section>
    </aside>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-5">
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
    {children}
  </section>
);

const Row = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt className="text-neutral-500">{k}</dt>
    <dd className="truncate text-neutral-200">{v}</dd>
  </>
);

const Danger = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className="rounded bg-red-600/80 px-2 py-1 text-xs hover:bg-red-600">
    {children}
  </button>
);
