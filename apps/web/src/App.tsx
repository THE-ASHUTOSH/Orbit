/**
 * Application shell.
 *
 * The server is authoritative for tabs, users and permissions: this component
 * only mirrors what it is told and sends intents back. It never invents state -
 * e.g. a tab does not appear in the UI until the server says tab.created.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ERROR_MESSAGES,
  type BrowserState,
  type Cursor,
  type ServerMetrics,
  type ServerMessage,
  type TabPermission,
} from '@orbit/protocol';
import { api, type SelfUser } from './lib/api';
import { BrowserSocket, type ConnectionStatus, type LatencySample } from './lib/socket';
import { Login } from './components/Login';
import { TabBar } from './components/TabBar';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/Viewport';
import { StatusBar } from './components/StatusBar';
import { Admin } from './components/Admin';

export function App() {
  const [self, setSelf] = useState<SelfUser | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void api
      .me()
      .then((r) => setSelf(r.user))
      .catch(() => setSelf(null))
      .finally(() => setBooted(true));
  }, []);

  if (!booted) return <Splash message="Loading…" />;
  if (!self) return <Login onSignedIn={setSelf} />;
  return <Workspace self={self} onSignedOut={() => setSelf(null)} />;
}

function Workspace({ self, onSignedOut }: { self: SelfUser; onSignedOut: () => void }) {
  const socket = useMemo(() => new BrowserSocket(), []);
  const [state, setState] = useState<BrowserState | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Record<string, TabPermission | null>>({});
  const [cursors, setCursors] = useState<Record<string, Cursor[]>>({});
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [latency, setLatency] = useState<LatencySample>(socket.latency);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [chooser, setChooser] = useState<{ tabId: string; multiple: boolean } | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeTabId;

  // --- socket wiring -------------------------------------------------------

  const subscribe = useCallback(
    (tabId: string) => {
      socket.send({
        type: 'tab.subscribe',
        tabId,
        // Ask for a stream that matches this screen; the server clamps it and
        // the first subscriber's size wins for everyone on that tab.
        width: Math.min(1920, Math.round(window.innerWidth * (window.devicePixelRatio > 1 ? 1 : 1))),
        height: Math.min(1080, Math.round(window.innerHeight - 140)),
      });
    },
    [socket],
  );

  useEffect(() => {
    const offStatus = socket.onStatus(setStatus);
    const offMsg = socket.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'hello': {
          setState(msg.state);
          // Restore the tab this user was last on: reconnect should feel like
          // nothing happened.
          const preferred =
            (activeRef.current && msg.state.tabs.some((t) => t.tabId === activeRef.current) && activeRef.current) ||
            (msg.self.currentTabId && msg.state.tabs.some((t) => t.tabId === msg.self.currentTabId)
              ? msg.self.currentTabId
              : null) ||
            msg.state.tabs[0]?.tabId ||
            null;
          if (preferred) {
            setActiveTabId(preferred);
            subscribe(preferred);
          }
          break;
        }
        case 'state':
          setState(msg.state);
          break;
        case 'presence':
          setState((s) => (s ? { ...s, users: msg.users } : s));
          break;
        case 'tab.created':
          setState((s) => (s ? { ...s, tabs: [...s.tabs.filter((t) => t.tabId !== msg.tab.tabId), msg.tab] } : s));
          // A popup opened by the page becomes a real tab; follow it if we have
          // nothing selected, otherwise leave the user where they are.
          setActiveTabId((cur) => {
            if (cur) return cur;
            subscribe(msg.tab.tabId);
            return msg.tab.tabId;
          });
          break;
        case 'tab.closed':
          setState((s) => (s ? { ...s, tabs: s.tabs.filter((t) => t.tabId !== msg.tabId) } : s));
          setActiveTabId((cur) => {
            if (cur !== msg.tabId) return cur;
            return null;
          });
          break;
        case 'tab.updated':
          setState((s) => (s ? { ...s, tabs: s.tabs.map((t) => (t.tabId === msg.tab.tabId ? msg.tab : t)) } : s));
          break;
        case 'tab.navigation':
          setState((s) =>
            s
              ? {
                  ...s,
                  tabs: s.tabs.map((t) =>
                    t.tabId === msg.tabId ? { ...t, url: msg.url, title: msg.title, loading: msg.loading } : t,
                  ),
                }
              : s,
          );
          break;
        case 'tab.permissions':
          setPermissions((p) => ({ ...p, [msg.tabId]: msg.permission }));
          break;
        case 'cursors':
          setCursors((c) => ({ ...c, [msg.tabId]: msg.cursors }));
          break;
        case 'browser.status':
          setState((s) => (s ? { ...s, status: msg.status, restarts: msg.restarts } : s));
          if (msg.status !== 'running') {
            setToast(msg.message ?? `Browser ${msg.status}…`);
          } else {
            setToast(null);
            // The browser came back (restart or crash recovery): the old stream
            // is gone with the old Chromium, so re-attach to the tab we are on.
            if (activeRef.current) subscribe(activeRef.current);
          }
          break;
        case 'metrics':
          setMetrics(msg.metrics);
          break;
        case 'file.chooser':
          setChooser({ tabId: msg.tabId, multiple: msg.multiple });
          break;
        case 'download':
          if (msg.state === 'completed') setToast(`Download finished: ${msg.fileName || 'file'}`);
          break;
        case 'clipboard.data':
          // Mirror the remote copy into the local clipboard when the browser
          // allows it; silently ignore when permission is denied.
          void navigator.clipboard?.writeText(msg.text).catch(() => {});
          break;
        case 'server.shutdown':
          setToast('The server is shutting down.');
          break;
        case 'error':
          setToast(msg.message || ERROR_MESSAGES.internal);
          break;
      }
      setLatency(socket.latency);
    });
    socket.connect();
    return () => {
      offStatus();
      offMsg();
      socket.close();
    };
  }, [socket, subscribe]);

  useEffect(() => {
    if (status === 'unauthorized') onSignedOut();
  }, [status, onSignedOut]);

  // Keep the latency readout live even between messages.
  useEffect(() => {
    if (!showMetrics) return;
    const t = window.setInterval(() => setLatency(socket.latency), 500);
    return () => window.clearInterval(t);
  }, [showMetrics, socket]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // --- actions -------------------------------------------------------------

  const selectTab = (tabId: string) => {
    if (tabId === activeTabId) return;
    if (activeTabId) socket.send({ type: 'tab.unsubscribe', tabId: activeTabId });
    setActiveTabId(tabId);
    subscribe(tabId);
  };

  const activeTab = state?.tabs.find((t) => t.tabId === activeTabId) ?? null;
  const permission = activeTabId ? permissions[activeTabId] : null;
  const canControl = self.role !== 'viewer' && (permission === 'control' || permission === 'admin');
  const canCreate = self.role !== 'viewer';

  // Auto-attach to a tab when ours closes or the first one appears.
  useEffect(() => {
    if (activeTabId || !state?.tabs.length) return;
    const next = state.tabs[0]!.tabId;
    setActiveTabId(next);
    subscribe(next);
  }, [activeTabId, state?.tabs, subscribe]);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-950 px-3 py-2">
        <h1 className="text-sm font-semibold">Orbit</h1>
        {state && state.status !== 'running' && (
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-300">{state.status}</span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-neutral-400">
          <span title={`signed in as ${self.username}`}>
            {self.displayName}
            <span className="ml-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
              {self.role}
            </span>
          </span>
          {self.role === 'admin' && (
            <button
              onClick={() => setShowAdmin((v) => !v)}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              admin panel
            </button>
          )}
          <button
            onClick={() => void api.logout().then(onSignedOut)}
            className="rounded px-2 py-1 hover:bg-neutral-800"
          >
            logout
          </button>
        </span>
      </header>

      <TabBar
        tabs={state?.tabs ?? []}
        activeTabId={activeTabId}
        users={state?.users ?? []}
        canCreate={canCreate}
        onSelect={selectTab}
        onClose={(tabId) => socket.send({ type: 'tab.close', tabId })}
        onCreate={() => socket.send({ type: 'tab.create' })}
        onRename={(tabId, label) => socket.send({ type: 'tab.rename', tabId, label })}
      />

      <Toolbar
        tab={activeTab}
        canControl={canControl}
        onNavigate={(url) => activeTabId && socket.send({ type: 'tab.navigate', tabId: activeTabId, url })}
        onAction={(action) => activeTabId && socket.send({ type: 'tab.action', tabId: activeTabId, action })}
      />

      <main className="relative min-h-0 flex-1">
        {activeTab ? (
          <Viewport
            socket={socket}
            tab={activeTab}
            canControl={canControl}
            cursors={cursors[activeTab.tabId] ?? []}
            selfUserId={self.userId}
          />
        ) : (
          <Splash message={state?.status === 'running' ? 'No tabs open. Press + to create one.' : 'Waiting for the browser…'} />
        )}

        {showAdmin && state && (
          <Admin
            state={state}
            metrics={metrics}
            onClose={() => setShowAdmin(false)}
            onCloseTab={(tabId) => socket.send({ type: 'tab.close', tabId })}
            onCreateTab={() => socket.send({ type: 'tab.create' })}
          />
        )}

        {chooser && (
          <FileChooser
            multiple={chooser.multiple}
            onCancel={() => {
              socket.send({ type: 'file.chooser.respond', tabId: chooser.tabId, files: [] });
              setChooser(null);
            }}
            onPick={async (files) => {
              const names: string[] = [];
              for (const file of files) names.push((await api.upload(file)).name);
              socket.send({ type: 'file.chooser.respond', tabId: chooser.tabId, files: names });
              setChooser(null);
            }}
          />
        )}

        {toast && (
          <div className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-neutral-800 px-4 py-2 text-xs shadow-lg">
            {toast}
          </div>
        )}
      </main>

      <StatusBar
        users={state?.users ?? []}
        selfUserId={self.userId}
        status={status}
        latency={latency}
        metrics={metrics}
        showMetrics={showMetrics}
        onToggleMetrics={() => setShowMetrics((v) => !v)}
      />
    </div>
  );
}

/**
 * The remote page asked for a file. The browser cannot hand a local file to
 * Chromium directly, so it is uploaded to the server's upload directory first
 * and attached to the page's input from there.
 */
function FileChooser({
  multiple,
  onPick,
  onCancel,
}: {
  multiple: boolean;
  onPick: (files: File[]) => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-semibold">The page is asking for a file</h3>
        <p className="mt-1 text-xs text-neutral-400">
          Your selection is uploaded to the server, then attached to the page's file input.
        </p>
        <input
          type="file"
          multiple={multiple}
          className="mt-3 w-full text-xs"
          onChange={(e) => onPick(Array.from(e.target.files ?? []))}
        />
        <button onClick={onCancel} className="mt-3 rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700">
          Cancel
        </button>
      </div>
    </div>
  );
}

const Splash = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center text-sm text-neutral-500">{message}</div>
);
