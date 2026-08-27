/**
 * Application shell.
 *
 * The server is authoritative for tabs, users and permissions: this component
 * only mirrors what it is told and sends intents back. It never invents state -
 * e.g. a tab does not appear in the UI until the server says tab.created.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ERROR_MESSAGES,
  type BrowserState,
  type Cursor,
  type ServerMetrics,
  type ServerMessage,
  type TabPermission,
} from "@orbit/protocol";
import { api, type Bookmark, type SelfUser } from "./lib/api";
import {
  BrowserSocket,
  type ConnectionStatus,
  type LatencySample,
} from "./lib/socket";
import { Login } from "./components/Login";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { Viewport } from "./components/Viewport";
import { StatusBar } from "./components/StatusBar";
import { Admin } from "./components/Admin";
import { Downloads } from "./components/Downloads";
import { Menu } from "./components/Menu";
import { BookmarksPanel, HistoryPanel } from "./components/BookmarksPanel";
import { ContextMenu, type ContextTarget } from "./components/ContextMenu";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import {
  AccessRequests,
  type AccessRequest,
} from "./components/AccessRequests";
import { useTheme } from "./lib/theme";
import { altChord } from "./lib/platform";
import {
  captureKeyboard,
  releaseKeyboard,
  enterFullscreen,
  exitFullscreen,
  fullCaptureAvailable,
  type CaptureMode,
} from "./lib/keyboard";

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

function Workspace({
  self,
  onSignedOut,
}: {
  self: SelfUser;
  onSignedOut: () => void;
}) {
  const socket = useMemo(() => new BrowserSocket(), []);
  const [state, setState] = useState<BrowserState | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<
    Record<string, TabPermission | null>
  >({});
  const [cursors, setCursors] = useState<Record<string, Cursor[]>>({});
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [latency, setLatency] = useState<LatencySample>(socket.latency);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const { theme, cycle: cycleTheme } = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const [chooser, setChooser] = useState<{
    tabId: string;
    multiple: boolean;
  } | null>(null);
  const [downloads, setDownloads] = useState<
    { name: string; size: number; modified: number }[]
  >([]);
  const [showDownloads, setShowDownloads] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [history, setHistory] = useState<
    { url: string; title: string; at: number; visits: number }[]
  >([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showExtensions, setShowExtensions] = useState(false);
  /**
   * Which tab is holding the keyboard, if any.
   *
   * Per tab, not per session: capture takes the screen and every chord, which is
   * right while you are working in one page and wrong the moment you switch. One
   * tab at a time, because fullscreen is a property of the document.
   */
  const [capture, setCapture] = useState<{
    tabId: string;
    mode: CaptureMode;
  } | null>(null);
  /**
   * Full screen: the page gets the whole display and Orbit's own chrome gets out
   * of the way. Worth having as more than a CSS trick - the stage grows, so the
   * server is asked for a bigger stream and the picture actually gets sharper.
   */
  const [immersive, setImmersive] = useState(false);
  /** Requests from other people for tabs this user owns. */
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  /** Tabs where this user has already asked the owner, so we stop asking. */
  const [asked, setAsked] = useState<Set<string>>(new Set());
  /** Set when the server answers a right-click probe. */
  const [context, setContext] = useState<ContextTarget | null>(null);
  /** Where the pending right-click happened on screen, for menu placement. */
  const contextAt = useRef({ x: 0, y: 0 });
  const addressRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeTabId;
  /**
   * Where this person has been, most recent last.
   *
   * Closing a tab should put you back where you came from - which is what a
   * browser does, and what a tab you were *redirected into* makes obvious: the
   * page you were reading is one step back, not "whichever tab happens to be
   * first". Per client, because everybody's path through the tabs differs.
   */
  const tabHistory = useRef<string[]>([]);
  /** Live tab list for the socket handler, whose closure would otherwise be stale. */
  const tabsRef = useRef<string[]>([]);
  tabsRef.current = state?.tabs.map((t) => t.tabId) ?? [];

  /** Record the tab being left, so closing the next one can come back to it. */
  const remember = (leaving: string | null) => {
    if (!leaving) return;
    tabHistory.current = [...tabHistory.current.filter((id) => id !== leaving), leaving].slice(-20);
  };

  /** The most recently visited tab that is still open. */
  const previousLiveTab = (excluding: string): string | null => {
    const open = new Set(tabsRef.current.filter((id) => id !== excluding));
    for (let i = tabHistory.current.length - 1; i >= 0; i--) {
      const candidate = tabHistory.current[i]!;
      if (open.has(candidate)) return candidate;
    }
    return null;
  };

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
    return {
      width: Math.max(320, Math.round(width)),
      height: Math.max(240, Math.round(height)),
    };
  }, []);

  const subscribe = useCallback(
    (tabId: string) => {
      // The server keeps the configured resolution but takes the aspect ratio
      // from here, so the frame fills the window instead of being letterboxed.
      socket.send({ type: "tab.subscribe", tabId, ...viewportArea() });
    },
    [socket, viewportArea],
  );

  useEffect(() => {
    const offStatus = socket.onStatus(setStatus);
    const offMsg = socket.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "hello": {
          setState(msg.state);
          // Restore the tab this user was last on: reconnect should feel like
          // nothing happened.
          const preferred =
            (activeRef.current &&
              msg.state.tabs.some((t) => t.tabId === activeRef.current) &&
              activeRef.current) ||
            (msg.self.currentTabId &&
            msg.state.tabs.some((t) => t.tabId === msg.self.currentTabId)
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
        case "state":
          setState(msg.state);
          break;
        case "presence":
          setState((s) => (s ? { ...s, users: msg.users } : s));
          break;
        case "tab.created":
          setState((s) =>
            s
              ? {
                  ...s,
                  tabs: [
                    ...s.tabs.filter((t) => t.tabId !== msg.tab.tabId),
                    msg.tab,
                  ],
                }
              : s,
          );
          setActiveTabId((cur) => {
            // Follow the new tab only if this user caused it - pressed +, or
            // clicked the link that opened it. Everyone else stays put, which is
            // the whole point of a per-person view onto a shared browser.
            const mine = msg.openedBy && msg.openedBy === self.userId;
            if (cur && !mine) return cur;
            if (cur && mine) {
              socket.send({ type: "tab.unsubscribe", tabId: cur });
              remember(cur);
            }
            subscribe(msg.tab.tabId);
            return msg.tab.tabId;
          });
          break;
        case "tab.closed": {
          setState((s) =>
            s ? { ...s, tabs: s.tabs.filter((t) => t.tabId !== msg.tabId) } : s,
          );
          tabHistory.current = tabHistory.current.filter((id) => id !== msg.tabId);
          // Back where we came from, if it is still open. Returning null hands
          // it to the auto-attach effect, which takes the first tab - the right
          // last resort, the wrong normal case.
          const back = previousLiveTab(msg.tabId);
          setActiveTabId((cur) => {
            if (cur !== msg.tabId) return cur;
            if (!back) return null;
            subscribe(back);
            return back;
          });
          break;
        }
        case "tab.updated":
          setState((s) =>
            s
              ? {
                  ...s,
                  tabs: s.tabs.map((t) =>
                    t.tabId === msg.tab.tabId ? msg.tab : t,
                  ),
                }
              : s,
          );
          break;
        case "tab.navigation":
          setState((s) =>
            s
              ? {
                  ...s,
                  tabs: s.tabs.map((t) =>
                    t.tabId === msg.tabId
                      ? {
                          ...t,
                          url: msg.url,
                          title: msg.title,
                          loading: msg.loading,
                        }
                      : t,
                  ),
                }
              : s,
          );
          break;
        case "tab.permissions":
          setPermissions((p) => ({ ...p, [msg.tabId]: msg.permission }));
          break;
        case "cursors":
          setCursors((c) => ({ ...c, [msg.tabId]: msg.cursors }));
          break;
        case "browser.status":
          setState((s) =>
            s ? { ...s, status: msg.status, restarts: msg.restarts } : s,
          );
          if (msg.status !== "running") {
            setToast(msg.message ?? `Browser ${msg.status}…`);
          } else {
            setToast(null);
            // The browser came back (restart or crash recovery): the old stream
            // is gone with the old Chromium, so re-attach to the tab we are on.
            if (activeRef.current) subscribe(activeRef.current);
          }
          break;
        case "metrics":
          setMetrics(msg.metrics);
          break;
        case "file.chooser":
          setChooser({ tabId: msg.tabId, multiple: msg.multiple });
          break;
        case "download":
          if (msg.state === "completed") {
            setToast(
              `Download finished: ${msg.fileName || "file"} - open Downloads to save it`,
            );
            // The file is on the server now; refresh so it can be saved locally.
            void api
              .downloads()
              .then((r) => setDownloads(r.files))
              .catch(() => {});
          }
          break;
        case "tab.access.requested":
          setAccessRequests((rs) =>
            rs.some((r) => r.tabId === msg.tabId && r.userId === msg.userId)
              ? rs
              : [
                  ...rs,
                  {
                    tabId: msg.tabId,
                    userId: msg.userId,
                    displayName: msg.displayName,
                    at: msg.at,
                  },
                ],
          );
          break;
        case "tab.access.decided":
          setAsked((a) => {
            const next = new Set(a);
            next.delete(msg.tabId);
            return next;
          });
          setToast(
            msg.granted
              ? `${msg.byDisplayName} gave you control of that tab.`
              : `${msg.byDisplayName} kept control of that tab.`,
          );
          break;
        case "context.info":
          setContext({
            x: contextAt.current.x,
            y: contextAt.current.y,
            link: msg.link,
            image: msg.image,
            selection: msg.selection,
          });
          break;
        case "clipboard.data":
          // Mirror the remote copy into the local clipboard when the browser
          // allows it; silently ignore when permission is denied.
          void navigator.clipboard?.writeText(msg.text).catch(() => {});
          break;
        case "server.shutdown":
          setToast("The server is shutting down.");
          break;
        case "error":
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
    if (status === "unauthorized") onSignedOut();
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
        if (
          Math.abs(area.width - lastSent.current.width) < 8 &&
          Math.abs(area.height - lastSent.current.height) < 8
        )
          return;
        lastSent.current = area;
        socket.send({ type: "tab.resize", tabId: tab.tabId, ...area });
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
    void api
      .downloads()
      .then((r) => setDownloads(r.files))
      .catch(() => {});
  }, []);

  const refreshBookmarks = useCallback(
    () =>
      void api
        .bookmarks()
        .then((r) => setBookmarks(r.bookmarks))
        .catch(() => {}),
    [],
  );
  useEffect(refreshBookmarks, [refreshBookmarks]);

  const refreshDownloads = () =>
    void api
      .downloads()
      .then((r) => setDownloads(r.files))
      .catch(() => {});

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
    if (activeTabId) {
      socket.send({ type: "tab.unsubscribe", tabId: activeTabId });
      remember(activeTabId);
    }
    setActiveTabId(tabId);
    subscribe(tabId);
  };

  const activeTab = state?.tabs.find((t) => t.tabId === activeTabId) ?? null;
  const permission = activeTabId ? permissions[activeTabId] : null;
  const canControl =
    self.role !== "viewer" &&
    (permission === "control" || permission === "admin");
  const canCreate = self.role !== "viewer";

  const navigate = (url: string) => {
    if (activeTabId)
      socket.send({ type: "tab.navigate", tabId: activeTabId, url });
  };
  const bookmarked =
    !!activeTab && bookmarks.some((b) => b.url === activeTab.url);
  const toggleBookmark = () => {
    if (!activeTab) return;
    const existing = bookmarks.find((b) => b.url === activeTab.url);
    const done = existing
      ? api.removeBookmark(existing.id)
      : api.addBookmark(activeTab.url, activeTab.title);
    void done
      .then(refreshBookmarks)
      .catch(() => setToast("Could not save the bookmark."));
  };

  const ownerOf = (tab: typeof activeTab) =>
    tab?.ownerId && tab.ownerId !== self.userId ? tab.ownerId : null;
  const nameOfUser = (userId: string) =>
    state?.users.find((u) => u.userId === userId)?.displayName ?? "the owner";

  /** Ask the owner of the current tab for control of it. */
  const requestControl = () => {
    if (!activeTabId) return;
    socket.send({ type: "tab.access.request", tabId: activeTabId });
    setAsked((a) => new Set(a).add(activeTabId));
  };

  const respondToRequest = (request: AccessRequest, grant: boolean) => {
    socket.send({
      type: "tab.access.respond",
      tabId: request.tabId,
      userId: request.userId,
      grant,
    });
    setAccessRequests((rs) =>
      rs.filter(
        (r) => !(r.tabId === request.tabId && r.userId === request.userId),
      ),
    );
  };

  /**
   * Take or release the keyboard for the current tab.
   *
   * Must run inside the user's gesture (the menu click, or the Alt+K keypress):
   * that is the only moment fullscreen may be requested, and the Keyboard Lock
   * API only applies while fullscreen.
   */
  const toggleCapture = () => {
    if (!activeTabId) return;
    if (capture) {
      void releaseKeyboard(immersive);
      setCapture(null);
      return;
    }
    void captureKeyboard(document.documentElement).then((mode) => {
      setCapture({ tabId: activeTabId, mode });
      if (mode === "partial") {
        setToast(
          fullCaptureAvailable()
            ? "Keyboard partly captured: fullscreen was refused, so this browser still keeps ⌘T and ⌘W."
            : "Keyboard partly captured: taking ⌘T and ⌘W needs https or 127.0.0.1, so this browser keeps them.",
        );
      }
    });
  };

  const toggleFullscreen = () => {
    if (immersive) {
      setImmersive(false);
      // Keyboard capture also needs the screen; leave it alone if it is on.
      if (!capture) void exitFullscreen();
      return;
    }
    void enterFullscreen(document.documentElement).then(() =>
      setImmersive(true),
    );
  };

  /** Capture belongs to one tab: switching tabs ends it. */
  useEffect(() => {
    if (capture && capture.tabId !== activeTabId) {
      void releaseKeyboard(immersive);
      setCapture(null);
    }
  }, [capture, activeTabId, immersive]);

  /** Leaving fullscreen by any route (Esc, F11, the OS) ends both of them. */
  useEffect(() => {
    if (!capture && !immersive) return;
    const onFullscreen = () => {
      if (document.fullscreenElement) return;
      setImmersive(false);
      if (capture) {
        void releaseKeyboard(false);
        setCapture(null);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [capture, immersive]);

  /**
   * Send a modifier chord to the page. The remote Chromium handles the editing
   * command itself, the way it would for a local keypress.
   *
   * 2 is Ctrl in the wire bitmask, and that is right whatever the viewer's OS
   * is: the browser receiving it is the Linux one in the container.
   */
  const chord = (key: string, code: string, modifiers: number) => {
    if (!activeTabId || !canControl) return;
    for (const event of ["keydown", "keyup"] as const)
      socket.sendInput({
        type: "input.keyboard",
        event,
        tabId: activeTabId,
        key,
        code,
        location: 0,
        repeat: false,
        modifiers,
      });
  };

  /**
   * Orbit's own shortcuts, on Alt/Option.
   *
   * Ctrl/Cmd chords (T, W, L, Tab, 1-9) belong to the browser Orbit is displayed
   * in and cannot be captured from a page - Ctrl+W would close the user's real
   * tab, not the remote one. Returning true means the key was consumed here.
   */
  const onShortcut = (action: string): boolean => {
    const numbered = /^selectTab:(\d)$/.exec(action);
    if (numbered) {
      const tabs = state?.tabs ?? [];
      const index =
        Number(numbered[1]) === 9 ? tabs.length - 1 : Number(numbered[1]) - 1;
      const target = tabs[index];
      if (target) selectTab(target.tabId);
      return !!target;
    }
    switch (action) {
      case "toggleCapture":
        toggleCapture();
        return true;
      case "toggleFullscreen":
        toggleFullscreen();
        return true;
      case "newTab":
        if (!canCreate) return false;
        socket.send({ type: "tab.create" });
        return true;
      case "closeTab":
        // No permission check here: closing is the server's call (it allows a
        // tab's owner and anyone whose role may close tabs), and a tab created a
        // moment ago has not been granted control yet.
        if (!activeTabId) return false;
        socket.send({ type: "tab.close", tabId: activeTabId });
        return true;
      case "reopenTab":
        if (!canCreate) return false;
        socket.send({ type: "tab.reopen" });
        return true;
      case "focusAddress":
        addressRef.current?.focus();
        addressRef.current?.select();
        return true;
      case "back":
      case "forward":
      case "reload":
        if (!activeTabId || !canControl) return false;
        socket.send({ type: "tab.action", tabId: activeTabId, action });
        return true;
      default:
        return false;
    }
  };

  // Auto-attach to a tab when ours closes or the first one appears.
  useEffect(() => {
    if (activeTabId || !state?.tabs.length) return;
    const next = state.tabs[0]!.tabId;
    setActiveTabId(next);
    subscribe(next);
  }, [activeTabId, state?.tabs, subscribe]);

  return (
    <div className="relative flex h-full flex-col">
      {/* In full screen the page gets everything; Orbit's chrome steps aside. */}
      {!immersive && (
        <>
          <TabBar
            tabs={state?.tabs ?? []}
            activeTabId={activeTabId}
            users={state?.users ?? []}
            canCreate={canCreate}
            onSelect={selectTab}
            onClose={(tabId) => socket.send({ type: "tab.close", tabId })}
            onCreate={() => socket.send({ type: "tab.create" })}
            onRename={(tabId, label) =>
              socket.send({ type: "tab.rename", tabId, label })
            }
          />

          <Toolbar
            ref={addressRef}
            tab={activeTab}
            canControl={canControl}
            bookmarked={bookmarked}
            onToggleBookmark={toggleBookmark}
            ownerName={
              // Only worth offering when asking could actually change something.
              !canControl && ownerOf(activeTab) && self.role !== "viewer"
                ? nameOfUser(activeTab!.ownerId!)
                : null
            }
            requestPending={!!activeTabId && asked.has(activeTabId)}
            onRequestControl={requestControl}
            onNavigate={navigate}
            onAction={(action) =>
              activeTabId &&
              socket.send({ type: "tab.action", tabId: activeTabId, action })
            }
            onResetZoom={() =>
              activeTabId &&
              socket.send({ type: "tab.zoom", tabId: activeTabId, zoom: 1 })
            }
            menu={
              <Menu
                zoom={activeTab?.zoom ?? 1}
                viewWidth={activeTab?.width ?? 0}
                viewHeight={activeTab?.height ?? 0}
                canControl={canControl}
                onZoom={(zoom) =>
                  activeTabId &&
                  socket.send({ type: "tab.zoom", tabId: activeTabId, zoom })
                }
                downloadCount={downloads.length}
                onOpenDownloads={() => {
                  setShowDownloads(true);
                  refreshDownloads();
                }}
                canInspect={
                  self.role === "admin" && (state?.features.devtools ?? false)
                }
                onInspect={() => {
                  if (!activeTabId) return;
                  // The server decides the URL: the client never learns the CDP port
                  // or the target id until it is allowed to.
                  void api
                    .devtoolsUrl(activeTabId)
                    .then((r) => window.open(r.url, "_blank", "noopener"))
                    .catch(() =>
                      setToast("DevTools is not enabled on this server."),
                    );
                }}
                isAdmin={self.role === "admin"}
                onOpenAdmin={() => setShowAdmin(true)}
                theme={theme}
                onCycleTheme={cycleTheme}
                showMetrics={showMetrics}
                onToggleMetrics={() => setShowMetrics((v) => !v)}
                fullscreen={immersive}
            onToggleFullscreen={toggleFullscreen}
            captured={!!capture}
                captureMode={capture?.mode ?? null}
                onToggleCapture={toggleCapture}
                bookmarkCount={bookmarks.length}
                onOpenBookmarks={() => {
                  setShowBookmarks(true);
                  refreshBookmarks();
                }}
                onOpenHistory={() => {
                  setShowHistory(true);
                  void api
                    .history()
                    .then((r) => setHistory(r.history))
                    .catch(() => {});
                }}
                onOpenExtensions={() => setShowExtensions(true)}
                onNewTab={() => socket.send({ type: "tab.create" })}
                onDuplicateTab={() =>
                  activeTabId &&
                  socket.send({
                    type: "tab.action",
                    tabId: activeTabId,
                    action: "duplicate",
                  })
                }
                onLogout={() => void api.logout().then(onSignedOut)}
              />
            }
          />
        </>
      )}

      <main ref={stageRef} className="relative min-h-0 flex-1">
        {activeTab ? (
          <Viewport
            socket={socket}
            tab={activeTab}
            canControl={canControl}
            onZoom={(zoom) =>
              activeTabId &&
              socket.send({ type: "tab.zoom", tabId: activeTabId, zoom })
            }
            cursors={cursors[activeTab.tabId] ?? []}
            selfUserId={self.userId}
            onShortcut={onShortcut}
            captured={capture?.tabId === activeTab.tabId ? capture.mode : null}
            onReleaseCapture={toggleCapture}
            onContextMenu={(pageX, pageY, screenX, screenY) => {
              contextAt.current = { x: screenX, y: screenY };
              socket.send({
                type: "context.probe",
                tabId: activeTab.tabId,
                x: pageX,
                y: pageY,
              });
            }}
          />
        ) : (
          <Splash
            message={
              state?.status === "running"
                ? "No tabs open. Press + to create one."
                : "Waiting for the browser…"
            }
          />
        )}

        {context && activeTab && (
          <ContextMenu
            target={context}
            canControl={canControl}
            canGoBack={activeTab.canGoBack}
            canGoForward={activeTab.canGoForward}
            onClose={() => setContext(null)}
            onAction={(action) =>
              socket.send({
                type: "tab.action",
                tabId: activeTab.tabId,
                action,
              })
            }
            onOpenLink={(url) => socket.send({ type: "tab.create", url })}
            onCopyText={(text) =>
              void navigator.clipboard?.writeText(text).catch(() => {})
            }
            onPageCopy={() => {
              // Both halves on purpose: the chord puts the selection on the
              // remote clipboard so an in-page paste works, and the probe
              // already told us the text, so put it on this machine's clipboard
              // directly rather than waiting for the page to report a copy.
              chord("c", "KeyC", 2);
              if (context.selection)
                void navigator.clipboard
                  ?.writeText(context.selection)
                  .catch(() => {});
            }}
            onPaste={() =>
              void navigator.clipboard
                ?.readText()
                .then(
                  (text) =>
                    text &&
                    socket.send({
                      type: "clipboard.write",
                      tabId: activeTab.tabId,
                      text,
                    }),
                )
                .catch(() =>
                  setToast("Your browser did not allow reading the clipboard."),
                )
            }
            onSelectAll={() => chord("a", "KeyA", 2)}
          />
        )}

        {showBookmarks && (
          <BookmarksPanel
            bookmarks={bookmarks}
            onClose={() => setShowBookmarks(false)}
            onOpen={(url) => {
              navigate(url);
              setShowBookmarks(false);
            }}
            onRemove={(id) =>
              void api
                .removeBookmark(id)
                .then(refreshBookmarks)
                .catch(() => {})
            }
          />
        )}

        {showHistory && (
          <HistoryPanel
            entries={history}
            onClose={() => setShowHistory(false)}
            onOpen={(url) => {
              navigate(url);
              setShowHistory(false);
            }}
            onSearch={(q) =>
              void api
                .history(q)
                .then((r) => setHistory(r.history))
                .catch(() => {})
            }
            canClear={self.role === "admin"}
            onClear={() =>
              void api
                .clearHistory()
                .then(() => setHistory([]))
                .catch(() => setToast("Only an admin can clear history."))
            }
          />
        )}

        {/* The way out. Dimmed until pointed at, because it sits over the page. */}
        {immersive && (
          <button
            onClick={toggleFullscreen}
            title={`Leave full screen (${altChord('F')})`}
            className="absolute right-3 top-3 z-30 rounded-full border border-line-2 bg-panel/70 px-3 py-1 text-[11px] text-ink-2 opacity-40 shadow-lg backdrop-blur transition-opacity hover:opacity-100"
          >
            ⤡ Leave full screen · {altChord('F')}
          </button>
        )}

        <AccessRequests
          requests={accessRequests}
          tabs={state?.tabs ?? []}
          onRespond={respondToRequest}
          onSelectTab={selectTab}
        />

        {showExtensions && (
          <ExtensionsPanel
            canOpen={canCreate}
            isAdmin={self.role === "admin"}
            onClose={() => setShowExtensions(false)}
            onManage={() => {
              setShowExtensions(false);
              setShowAdmin(true);
            }}
            onError={setToast}
          />
        )}

        {showDownloads && (
          <Downloads
            files={downloads}
            onClose={() => setShowDownloads(false)}
            onRefresh={refreshDownloads}
            onDelete={(name) =>
              void api.deleteDownload(name).then(refreshDownloads)
            }
          />
        )}

        {showAdmin && state && (
          <Admin
            state={state}
            metrics={metrics}
            onClose={() => setShowAdmin(false)}
            onCloseTab={(tabId) => socket.send({ type: "tab.close", tabId })}
            onCreateTab={() => socket.send({ type: "tab.create" })}
          />
        )}

        {chooser && (
          <FileChooser
            multiple={chooser.multiple}
            onCancel={() => {
              socket.send({
                type: "file.chooser.respond",
                tabId: chooser.tabId,
                files: [],
              });
              setChooser(null);
            }}
            onPick={async (files) => {
              const names: string[] = [];
              for (const file of files)
                names.push((await api.upload(file)).name);
              socket.send({
                type: "file.chooser.respond",
                tabId: chooser.tabId,
                files: names,
              });
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

      {!immersive && (
        <StatusBar
          users={state?.users ?? []}
          tabs={state?.tabs ?? []}
          browserStatus={state?.status ?? "starting"}
          selfUserId={self.userId}
          status={status}
          latency={latency}
          metrics={metrics}
          showMetrics={showMetrics}
        />
      )}
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
          Your selection is uploaded to the server, then attached to the page's
          file input.
        </p>
        <input
          type="file"
          multiple={multiple}
          className="mt-3 w-full text-xs"
          onChange={(e) => onPick(Array.from(e.target.files ?? []))}
        />
        <button
          onClick={onCancel}
          className="mt-3 rounded bg-elev px-3 py-1.5 text-xs hover:bg-elev-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const Splash = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center text-sm text-ink-3">
    {message}
  </div>
);
