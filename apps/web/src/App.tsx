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
import { Downloads } from './components/Downloads';
import { Menu } from './components/Menu';
import { useTheme } from './lib/theme';

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
  const { theme, cycle: cycleTheme } = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const [chooser, setChooser] = useState<{ tabId: string; multiple: boolean } | null>(null);
  const [downloads, setDownloads] = useState<{ name: string; size: number; modified: number }[]>([]);
  const [showDownloads, setShowDownloads] = useState(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeTabId;

  // --- socket wiring -------------------------------------------------------

  /**
   * The area actually available for the frame, which the server uses as the
   * stream's aspect ratio. Measured from the element rather than derived from
   * window height minus a guessed chrome height: a guess that is a few pixels
   * out makes the frame slightly the wrong shape, which then shows up as either
   * black bars or a cropped edge.
   */
  const stageRef = useRef<HTMLElement | null>(null);
  const viewportArea = useCallback(() => {
    const el = stageRef.current;
    const width = el?.clientWidth || window.innerWidth;
    const height = el?.clientHeight || window.innerHeight - 104;
    return { width: Math.max(320, Math.round(width)), height: Math.max(240, Math.round(height)) };
  }, []);

  const subscribe = useCallback(
    (tabId: string) => {
      // The server keeps the configured resolution but takes the aspect ratio
      // from here, so the frame fills the window instead of being letterboxed.
      socket.send({ type: 'tab.subscribe', tabId, ...viewportArea() });
    },
    [socket, viewportArea],
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
          setActiveTabId((cur) => {
            // Follow the new tab only if this user caused it - pressed +, or
            // clicked the link that opened it. Everyone else stays put, which is
            // the whole point of a per-person view onto a shared browser.
            const mine = msg.openedBy && msg.openedBy === self.userId;
            if (cur && !mine) return cur;
            if (cur && mine) socket.send({ type: 'tab.unsubscribe', tabId: cur });
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
          if (msg.state === 'completed') {
            setToast(`Download finished: ${msg.fileName || 'file'} - open Downloads to save it`);
            // The file is on the server now; refresh so it can be saved locally.
            void api.downloads().then((r) => setDownloads(r.files)).catch(() => {});
          }
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

  /**
   * Keep the stream's shape matching the stage.
   *
   * An observer rather than a window 'resize' listener: the first subscribe
   * happens before the chrome has finished laying out, so the initial
   * measurement is a little too tall and the frame comes back the wrong shape.
   * Watching the element corrects that as soon as it settles, and covers window
   * resizes for free.
   *
   * Only while nobody else is on the tab - the viewport is shared, and reshaping
   * it under someone else mid-sentence would be rude.
   */
  const lastSent = useRef({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let timer = 0;
    const sync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const tab = state?.tabs.find((t) => t.tabId === activeRef.current);
        if (!tab || tab.viewers.length > 1) return;
        const area = viewportArea();
        // Ignore sub-pixel churn so this cannot oscillate.
        if (Math.abs(area.width - lastSent.current.width) < 8 && Math.abs(area.height - lastSent.current.height) < 8)
          return;
        lastSent.current = area;
        socket.send({ type: 'tab.resize', tabId: tab.tabId, ...area });
      }, 350);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [socket, state?.tabs, viewportArea]);

  useEffect(() => {
    void api.downloads().then((r) => setDownloads(r.files)).catch(() => {});
  }, []);

  const refreshDownloads = () => void api.downloads().then((r) => setDownloads(r.files)).catch(() => {});

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
        onResetZoom={() => activeTabId && socket.send({ type: 'tab.zoom', tabId: activeTabId, zoom: 1 })}
        menu={
          <Menu
            zoom={activeTab?.zoom ?? 1}
            viewWidth={activeTab?.width ?? 0}
            viewHeight={activeTab?.height ?? 0}
            canControl={canControl}
            onZoom={(zoom) => activeTabId && socket.send({ type: 'tab.zoom', tabId: activeTabId, zoom })}
            downloadCount={downloads.length}
            onOpenDownloads={() => {
              setShowDownloads(true);
              refreshDownloads();
            }}
            canInspect={self.role === 'admin' && (state?.features.devtools ?? false)}
            onInspect={() => {
              if (!activeTabId) return;
              // The server decides the URL: the client never learns the CDP port
              // or the target id until it is allowed to.
              void api
                .devtoolsUrl(activeTabId)
                .then((r) => window.open(r.url, '_blank', 'noopener'))
                .catch(() => setToast('DevTools is not enabled on this server.'));
            }}
            isAdmin={self.role === 'admin'}
            onOpenAdmin={() => setShowAdmin(true)}
            theme={theme}
            onCycleTheme={cycleTheme}
            showMetrics={showMetrics}
            onToggleMetrics={() => setShowMetrics((v) => !v)}
            onNewTab={() => socket.send({ type: 'tab.create' })}
            onDuplicateTab={() => activeTabId && socket.send({ type: 'tab.action', tabId: activeTabId, action: 'duplicate' })}
            onLogout={() => void api.logout().then(onSignedOut)}
          />
        }
      />

      <main ref={stageRef} className="relative min-h-0 flex-1">
        {activeTab ? (
          <Viewport
            socket={socket}
            tab={activeTab}
            canControl={canControl}
            onZoom={(zoom) => activeTabId && socket.send({ type: 'tab.zoom', tabId: activeTabId, zoom })}
            cursors={cursors[activeTab.tabId] ?? []}
            selfUserId={self.userId}
          />
        ) : (
          <Splash message={state?.status === 'running' ? 'No tabs open. Press + to create one.' : 'Waiting for the browser…'} />
        )}

        {showDownloads && (
          <Downloads
            files={downloads}
            onClose={() => setShowDownloads(false)}
            onRefresh={refreshDownloads}
            onDelete={(name) => void api.deleteDownload(name).then(refreshDownloads)}
          />
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
          <div className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-elev px-4 py-2 text-xs shadow-lg">
            {toast}
          </div>
        )}
      </main>

      <StatusBar
        users={state?.users ?? []}
        tabs={state?.tabs ?? []}
        browserStatus={state?.status ?? 'starting'}
        selfUserId={self.userId}
        status={status}
        latency={latency}
        metrics={metrics}
        showMetrics={showMetrics}
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
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-stage/60 p-4">
      <div className="w-full max-w-sm rounded-lg border border-line-2 bg-panel p-4">
        <h3 className="text-sm font-semibold">The page is asking for a file</h3>
        <p className="mt-1 text-xs text-ink-2">
          Your selection is uploaded to the server, then attached to the page's file input.
        </p>
        <input
          type="file"
          multiple={multiple}
          className="mt-3 w-full text-xs"
          onChange={(e) => onPick(Array.from(e.target.files ?? []))}
        />
        <button onClick={onCancel} className="mt-3 rounded bg-elev px-3 py-1.5 text-xs hover:bg-elev-2">
          Cancel
        </button>
      </div>
    </div>
  );
}

const Splash = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center text-sm text-ink-3">{message}</div>
);
