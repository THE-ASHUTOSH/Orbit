/**
 * Tabs: stable application ids over volatile Chromium targets.
 *
 * A tab is identified by `tab_<ulid>` for the whole life of the deployment. The
 * Chromium targetId behind it can change (crash recovery recreates the page) and
 * clients never notice, which is what makes reconnect-to-previous-tab work.
 */
import { EventEmitter } from 'node:events';
import type { TabInfo } from '@orbit/protocol';
import { config } from '../config.js';
import { log } from '../log.js';
import { id } from '../ids.js';
import {
  insertTab,
  listOpenTabs,
  markTabClosed,
  renameTab,
  setTabOwner,
  updateTabMeta,
  updateTabTarget,
  audit,
} from '../db.js';
import type { BrowserManager } from './BrowserManager.js';
import type { CdpConnection, CdpEvent } from './cdp.js';

export interface Tab {
  tabId: string;
  targetId: string;
  /** CDP flat session for this page. Empty while re-attaching. */
  sessionId: string;
  label: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Streamed viewport, i.e. base size divided by zoom. */
  width: number;
  height: number;
  /** Tab whose page opened this one (window.open, target=_blank), if any. */
  openerTabId: string | null;
  /** Size zoom is applied to, so zooming is reversible without drift. */
  baseWidth: number;
  baseHeight: number;
  zoom: number;
  createdAt: number;
  createdBy: string | null;
}

/** Schemes a remote user is never allowed to steer the shared browser into. */
const BLOCKED_SCHEMES = /^(file|chrome|chrome-extension|devtools|view-source|filesystem):/i;

export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw === 'about:blank') return raw;
  if (BLOCKED_SCHEMES.test(raw)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : // Bare "example.com" is a URL; "how tall is everest" is a search.
      /^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(raw)
      ? `https://${raw}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
  try {
    const u = new URL(candidate);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * The largest viewport this deployment can actually render.
 *
 * Headed Chromium draws into a real window on a real (virtual) screen, and a
 * window cannot be bigger than its screen. Ask for more and the screencast comes
 * back black - measured: at 50% zoom the viewport grew to 2560x1216 on a
 * 1920x1080 screen and every frame was 100% black. Headless has no window, so
 * only the configured maximum applies there.
 */
export function maxViewport(): { width: number; height: number } {
  if (config.headless) return { width: config.viewport.maxWidth, height: config.viewport.maxHeight };
  return {
    width: Math.min(config.viewport.maxWidth, config.display.width),
    height: Math.min(config.viewport.maxHeight, config.display.height),
  };
}

/**
 * Snap DOWN to a 16px grid: see viewportFor.
 *
 * Down, not nearest: rounding up overshoots the area the client actually has -
 * and on a headed browser overshooting the screen is what turns a frame black.
 */
const snap = (n: number) => Math.max(16, Math.floor(n / 16) * 16);

/**
 * How big a tab's viewport should be, given what a client asked for.
 *
 * One function for both `tab.subscribe` and `tab.resize`, because they used to
 * disagree: subscribe honoured PIN_VIEWPORT and resize did not, so the size
 * flipped between the pinned resolution and the client's raw window depending on
 * which message landed last - and again after every refresh. That is the
 * "resolution is different every time" bug.
 *
 * Snapped to a 16px grid on purpose. Without it, two pixels of difference in a
 * client's layout produced a different viewport, a different stream restart and a
 * different-looking page for no reason a user could see.
 */
export function viewportFor(
  requested: { width?: number | null; height?: number | null } | null,
  // Injectable so the rule can be tested at both PIN_VIEWPORT settings without
  // reloading the process.
  opts: {
    configured?: { width: number; height: number };
    max?: { width: number; height: number };
    pin?: boolean;
  } = {},
): { width: number; height: number } {
  const configured = opts.configured ?? { width: config.viewport.width, height: config.viewport.height };
  const max = opts.max ?? maxViewport();
  const pin = opts.pin ?? config.pinViewport;
  const aspect =
    requested?.width && requested?.height ? requested.height / requested.width : configured.height / configured.width;

  /**
   * Only what the client's window implies is snapped. A configured resolution is
   * an operator's decision and passes through exactly: 1920x1080 must mean
   * 1920x1080, not the nearest multiple of sixteen.
   */
  const hasRequest = !!(requested?.width && requested?.height);
  const wanted = pin
    ? { width: configured.width, height: hasRequest ? snap(configured.width * aspect) : configured.height }
    : {
        width: requested?.width ? snap(requested.width) : configured.width,
        height: requested?.height ? snap(requested.height) : configured.height,
      };

  return {
    width: Math.max(240, Math.min(wanted.width, max.width)),
    height: Math.max(180, Math.min(wanted.height, max.height)),
  };
}

/**
 * Which URL a tab should open: what was asked for, else the configured home,
 * falling back to about:blank when neither is a usable http(s) address.
 */
export function resolveTabUrl(requested: string | null | undefined, home: string): string {
  const wanted = requested ?? home;
  if (!wanted || wanted === 'about:blank') return 'about:blank';
  return normalizeUrl(wanted) ?? 'about:blank';
}

export class TabManager extends EventEmitter {
  private tabs = new Map<string, Tab>();
  private byTarget = new Map<string, string>();
  private bySession = new Map<string, string>();
  private cdp: CdpConnection | null = null;
  /**
   * Targets we created for a known tabId, awaiting their attach event. The
   * metadata rides along because Chromium's targetInfo knows nothing about our
   * labels or who asked for the tab.
   */
  private expecting = new Map<
    string,
    { tabId: string; label: string | null; createdBy: string | null; width?: number; height?: number }
  >();
  /**
   * In-flight Target.createTarget calls. Auto-attach can deliver
   * Target.attachedToTarget BEFORE createTarget's response, in which case the
   * new page would look like an unsolicited popup and be given a fresh id.
   * onAttached waits on these so the reservation is always in place first.
   */
  private inflightCreates = new Set<Promise<unknown>>();
  /**
   * Creates that have passed the tab limit but do not yet appear in `tabs`.
   * Without this the limit is a suggestion under any concurrency.
   */
  private pendingCreates = 0;

  constructor(private readonly browser: BrowserManager) {
    super();
    this.setMaxListeners(0);
  }

  list(): Tab[] {
    return [...this.tabs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  get(tabId: string): Tab | undefined {
    return this.tabs.get(tabId);
  }
  get count(): number {
    return this.tabs.size;
  }

  info(tab: Tab, viewers: string[] = []): TabInfo {
    return {
      tabId: tab.tabId,
      targetId: tab.targetId,
      label: tab.label,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      width: tab.width,
      height: tab.height,
      zoom: tab.zoom,
      createdAt: tab.createdAt,
      ownerId: tab.createdBy,
      viewers,
    };
  }

  /**
   * Claim a tab for the user Chromium opened it for.
   *
   * Popups and a captured Ctrl+T arrive with no owner - only the input arbiter
   * knows who clicked the link - so the hub attributes them and calls this.
   */
  claim(tabId: string, userId: string): Tab | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.createdBy) return tab;
    tab.createdBy = userId;
    setTabOwner(tabId, userId);
    return tab;
  }

  /** Wire up a fresh CDP connection and rebuild tab state on top of it. */
  async attach(cdp: CdpConnection): Promise<void> {
    this.cdp = cdp;
    cdp.on('Target.attachedToTarget', (e: CdpEvent) => void this.onAttached(e));
    cdp.on('Target.detachedFromTarget', (e: CdpEvent) => this.onDetached(e.params.sessionId));
    cdp.on('Target.targetDestroyed', (e: CdpEvent) => this.onTargetGone(e.params.targetId));
    cdp.on('Target.targetInfoChanged', (e: CdpEvent) => this.onTargetInfo(e.params.targetInfo));
    cdp.on('Page.lifecycleEvent', (e: CdpEvent) => this.onLifecycle(e));
    cdp.on('Page.frameNavigated', (e: CdpEvent) => this.onFrameNavigated(e));
    cdp.on('Page.javascriptDialogOpening', (e: CdpEvent) => void this.onDialog(e));
    cdp.on('Inspector.targetCrashed', (e: CdpEvent) => void this.onRendererCrash(e));

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.restoreTabs();
  }

  /**
   * Rebuild tab state on a fresh connection: first start, or recovery after a
   * crash or restart.
   *
   * Order is load-bearing. Existing page targets are claimed for their previous
   * tab ids BEFORE auto-attach is enabled, because enabling it immediately
   * attaches every open page - and an unclaimed page is treated as a popup and
   * given a brand new id, which would break "reconnect to your previous tab"
   * across a restart.
   */
  private async restoreTabs(): Promise<void> {
    const previous = new Map([...this.tabs.values()].map((t) => [t.tabId, t]));
    this.tabs.clear();
    this.byTarget.clear();
    this.bySession.clear();
    this.expecting.clear();

    const { targetInfos } = await this.cdp!.send<{ targetInfos: any[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    const persisted = listOpenTabs();

    // Claim one live page per remembered tab, oldest first.
    const spare = [...pages];
    const claimed: { row: (typeof persisted)[number]; targetId: string }[] = [];
    const orphaned: (typeof persisted)[number][] = [];
    for (const row of persisted) {
      const target = spare.shift();
      if (!target) {
        orphaned.push(row);
        continue;
      }
      this.expecting.set(target.targetId, { tabId: row.id, label: row.label, createdBy: row.created_by });
      claimed.push({ row, targetId: target.targetId });
    }

    // Now let Chromium hand us sessions for everything, claimed or not. Leftover
    // pages (there is normally one about:blank on a cold start) get adopted with
    // fresh ids by onAttached.
    await this.cdp!.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    for (const { row, targetId } of claimed) {
      const tab = await this.waitForTab(row.id, 10_000);
      if (!tab) {
        log.warn('claimed target never attached', { tabId: row.id, targetId });
        continue;
      }
      const prior = previous.get(row.id);
      if (prior) {
        // Restore the BASE size and the zoom separately. Passing the effective
        // (already zoomed) size would fold the zoom into the base and compound
        // it on every restart.
        await this.resize(row.id, prior.baseWidth, prior.baseHeight).catch(() => {});
        if (prior.zoom !== 1) await this.setZoom(row.id, prior.zoom).catch(() => {});
      }
      // Put the page back where it was; a reused about:blank has no history.
      if (row.url && row.url !== 'about:blank' && tab.url !== row.url) {
        await this.cdp!.send('Page.navigate', { url: row.url }, tab.sessionId).catch((err) =>
          log.warn('restore navigation failed', { tabId: row.id, err }),
        );
      }
    }

    // Tabs with no page left to claim are recreated so their ids survive.
    for (const row of orphaned) {
      await this.createTab({
        url: row.url || 'about:blank',
        label: row.label,
        createdBy: row.created_by,
        reuseTabId: row.id,
        width: previous.get(row.id)?.baseWidth,
        height: previous.get(row.id)?.baseHeight,
      }).catch((err) => log.warn('tab restore failed', { tabId: row.id, err }));
    }

    // No url: createTab falls back to HOME_URL.
    if (this.tabs.size === 0) await this.createTab({ createdBy: null });
    log.info('tabs restored', { count: this.tabs.size, reclaimed: claimed.length, recreated: orphaned.length });
  }

  /**
   * Create a page. `reuseTabId` re-materialises a tab that existed before a
   * crash so clients keep the same tabId across recovery.
   */
  async createTab(opts: {
    url?: string | null;
    /**
     * A URL the server built itself, used as-is. Only for schemes a client may
     * not ask for by name - chrome-extension:// pages, opened from the installed
     * extension list. Never fed from a client message.
     */
    trustedUrl?: string;
    label?: string | null;
    createdBy: string | null;
    reuseTabId?: string;
    width?: number;
    height?: number;
  }): Promise<Tab> {
    if (!this.cdp?.connected) throw new Error('browser_unavailable');
    /**
     * Count the tabs being born, not just the ones already here.
     *
     * A tab only lands in `this.tabs` when Chromium attaches its session, which
     * is several awaits away - so a burst of creates all passed this check
     * before any of them had registered. Measured with the stress harness:
     * twenty-four tabs open against a limit of twenty.
     */
    if (!opts.reuseTabId && this.tabs.size + this.pendingCreates >= config.maxTabs) throw new Error('tab_limit');
    this.pendingCreates++;
    try {
      return await this.createTabInner(opts);
    } finally {
      this.pendingCreates--;
    }
  }

  /** The body of createTab; the reservation above is what bounds it. */
  private async createTabInner(opts: {
    url?: string | null;
    trustedUrl?: string;
    label?: string | null;
    createdBy: string | null;
    reuseTabId?: string;
    width?: number;
    height?: number;
  }): Promise<Tab> {
    const tabId = opts.reuseTabId ?? id('tab');
    const url = opts.trustedUrl ?? resolveTabUrl(opts.url, config.homeUrl);
    // Headless composites every page target, so tabs can share one window. A
    // headed browser only composites the focused window, so each tab gets its
    // own - otherwise every background tab's stream freezes.
    // width/height are only accepted for a new window, and the streamed viewport
    // is set per page by setDeviceMetricsOverride in setupPage regardless.
    const params: Record<string, unknown> = config.headless
      ? { url }
      : {
          url,
          newWindow: true,
          // The window must match the viewport. Larger and the screencast
          // captures the whole window surface, so the page occupies part of it
          // and the rest arrives as black padding.
          width: config.viewport.width,
          height: config.viewport.height,
        };
    // The connection was checked by createTab before the reservation was taken.
    const cdp = this.cdp;
    if (!cdp?.connected) throw new Error('browser_unavailable');
    const creating = cdp
      .send<{ targetId: string }>('Target.createTarget', params)
      .then(({ targetId }) => {
        this.expecting.set(targetId, {
          tabId,
          label: opts.label ?? null,
          createdBy: opts.createdBy,
          width: opts.width,
          height: opts.height,
        });
        return targetId;
      });
    this.inflightCreates.add(creating);
    let targetId: string;
    try {
      targetId = await creating;
    } finally {
      this.inflightCreates.delete(creating);
    }
    if (!opts.reuseTabId) {
      insertTab({
        id: tabId,
        browserId: this.browser.browserId,
        targetId,
        label: opts.label ?? null,
        url,
        title: '',
        createdBy: opts.createdBy,
      });
      audit('tab.create', { userId: opts.createdBy, tabId, detail: { url } });
    } else {
      updateTabTarget(tabId, targetId);
    }

    // Auto-attach delivers the session; wait for it so callers get a usable tab.
    const tab = await this.waitForTab(tabId, 10_000);
    if (!tab) throw new Error('internal');
    return tab;
  }

  private waitForTab(tabId: string, timeoutMs: number): Promise<Tab | null> {
    const existing = this.tabs.get(tabId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('tab.created', onCreated);
        resolve(this.tabs.get(tabId) ?? null);
      }, timeoutMs);
      const onCreated = (t: Tab) => {
        if (t.tabId !== tabId) return;
        clearTimeout(timer);
        this.off('tab.created', onCreated);
        resolve(t);
      };
      this.on('tab.created', onCreated);
    });
  }

  private async onAttached(e: CdpEvent): Promise<void> {
    const { sessionId, targetInfo } = e.params as { sessionId: string; targetInfo: any };
    if (targetInfo.type !== 'page') return; // iframes/workers/service workers
    const known = this.byTarget.get(targetInfo.targetId);
    if (known) {
      // Re-attach of a page we already track (e.g. after detach).
      const tab = this.tabs.get(known)!;
      this.bySession.delete(tab.sessionId);
      tab.sessionId = sessionId;
      this.bySession.set(sessionId, tab.tabId);
      await this.setupPage(tab);
      return;
    }

    // If a createTarget is still in flight, its reservation may not have been
    // recorded yet - wait for it before deciding this is an unsolicited popup.
    if (!this.expecting.has(targetInfo.targetId) && this.inflightCreates.size > 0) {
      await Promise.allSettled([...this.inflightCreates]);
    }
    const reserved = this.expecting.get(targetInfo.targetId);
    this.expecting.delete(targetInfo.targetId);
    const isNewPopup = !reserved;
    const tabId = reserved?.tabId ?? id('tab');

    const tab: Tab = {
      tabId,
      targetId: targetInfo.targetId,
      sessionId,
      label: reserved?.label ?? null,
      url: targetInfo.url ?? 'about:blank',
      title: targetInfo.title ?? '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      width: reserved?.width ?? config.viewport.width,
      height: reserved?.height ?? config.viewport.height,
      openerTabId: targetInfo.openerId ? (this.byTarget.get(targetInfo.openerId) ?? null) : null,
      baseWidth: reserved?.width ?? config.viewport.width,
      baseHeight: reserved?.height ?? config.viewport.height,
      zoom: 1,
      createdAt: Date.now(),
      createdBy: reserved?.createdBy ?? null,
    };
    this.tabs.set(tabId, tab);
    this.byTarget.set(tab.targetId, tabId);
    this.bySession.set(sessionId, tabId);

    if (isNewPopup) {
      // window.open / target=_blank: Chromium made a page nobody asked us for.
      insertTab({
        id: tabId,
        browserId: this.browser.browserId,
        targetId: tab.targetId,
        label: null,
        url: tab.url,
        title: tab.title,
        createdBy: null,
      });
      log.info('adopted new browser target', { tabId, url: tab.url });
    }

    await this.setupPage(tab);

    /**
     * A tab Chromium opened for itself starts on its own new-tab page. That
     * happens when a captured Ctrl/⌘+T reaches the remote browser, and
     * chrome://newtab is not a page a user of Orbit asked for - send it to the
     * same home page the "+" button uses, so both routes behave alike.
     */
    if (isNewPopup && /^chrome:\/\/(newtab|new-tab-page)/.test(tab.url)) {
      await this.cdp!.send('Page.navigate', { url: resolveTabUrl(null, config.homeUrl) }, sessionId).catch((err) =>
        log.warn('new-tab redirect failed', { tabId, err }),
      );
    }

    this.emit('tab.created', tab);
  }

  /** Per-page CDP setup. Re-run on every attach, including after recovery. */
  private async setupPage(tab: Tab): Promise<void> {
    const s = tab.sessionId;
    const cdp = this.cdp!;
    try {
      await cdp.send('Page.enable', {}, s);
      await cdp.send('Runtime.enable', {}, s);
      await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, s);
      await cdp.send('Inspector.enable', {}, s).catch(() => {});
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: tab.width, height: tab.height, deviceScaleFactor: config.deviceScaleFactor, mobile: false },
        s,
      );
      // Without focus emulation only the foreground tab believes it is focused,
      // so carets stop blinking and :focus styles die on every other tab - fatal
      // when four people are typing in four tabs at once.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, s).catch(() => {});
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: config.timezone }, s).catch(() => {});
      if (config.uploadsEnabled)
        await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, s).catch(() => {});
      await this.refreshHistory(tab);
    } catch (err) {
      log.warn('page setup incomplete', { tabId: tab.tabId, err: err as Error });
    }
    this.emit('page.attached', tab);
  }

  private onDetached(sessionId: string) {
    const tabId = this.bySession.get(sessionId);
    if (!tabId) return;
    this.bySession.delete(sessionId);
    const tab = this.tabs.get(tabId);
    if (tab && tab.sessionId === sessionId) tab.sessionId = '';
  }

  private onTargetGone(targetId: string) {
    const tabId = this.byTarget.get(targetId);
    if (!tabId) return;
    const tab = this.tabs.get(tabId);
    this.byTarget.delete(targetId);
    this.tabs.delete(tabId);
    if (tab?.sessionId) this.bySession.delete(tab.sessionId);
    markTabClosed(tabId);
    log.info('tab closed', { tabId });
    this.emit('tab.closed', tabId);
  }

  private onTargetInfo(targetInfo: any) {
    if (targetInfo.type !== 'page') return;
    const tabId = this.byTarget.get(targetInfo.targetId);
    if (!tabId) return;
    const tab = this.tabs.get(tabId)!;
    const changed = tab.url !== targetInfo.url || tab.title !== targetInfo.title;
    tab.url = targetInfo.url ?? tab.url;
    tab.title = targetInfo.title ?? tab.title;
    if (changed) {
      updateTabMeta(tabId, tab.url, tab.title);
      this.emit('tab.navigation', tab);
    }
  }

  private onLifecycle(e: CdpEvent) {
    const tabId = this.bySession.get(e.sessionId ?? '');
    if (!tabId) return;
    const tab = this.tabs.get(tabId)!;
    const name = e.params.name as string;
    const before = tab.loading;
    if (name === 'init') tab.loading = true;
    else if (name === 'load' || name === 'networkIdle') tab.loading = false;
    if (tab.loading !== before) this.emit('tab.navigation', tab);
  }

  private onFrameNavigated(e: CdpEvent) {
    const tabId = this.bySession.get(e.sessionId ?? '');
    if (!tabId || e.params.frame?.parentId) return; // main frame only
    const tab = this.tabs.get(tabId)!;
    tab.url = e.params.frame.url ?? tab.url;
    updateTabMeta(tabId, tab.url, tab.title);
    void this.refreshHistory(tab);
    this.emit('tab.navigation', tab);
  }

  /**
   * Dismiss javascript dialogs. alert()/confirm() block the renderer, which
   * would freeze the tab's stream for every viewer; a shared browser cannot
   * afford one user's stuck modal.
   */
  private async onDialog(e: CdpEvent): Promise<void> {
    const tabId = this.bySession.get(e.sessionId ?? '');
    log.info('dismissing javascript dialog', { tabId, dialog: e.params.type });
    await this.cdp!.send('Page.handleJavaScriptDialog', { accept: e.params.type === 'beforeunload' }, e.sessionId).catch(
      () => {},
    );
  }

  /**
   * A page's renderer died - typically memory exhaustion on a heavy page.
   *
   * Without this the tab becomes a zombie: the target still exists, so nothing
   * looks broken, but no frames are ever produced again and input goes nowhere.
   * Reloading respawns the renderer; the stream is re-armed by the listener on
   * 'tab.crashed'.
   */
  private async onRendererCrash(e: CdpEvent): Promise<void> {
    const tab = this.tabForSession(e.sessionId ?? '');
    if (!tab) return;
    log.error('page renderer crashed - reloading', { tabId: tab.tabId, url: tab.url });
    tab.loading = true;
    this.emit('tab.crashed', tab);
    await this.cdp!.send('Page.reload', {}, tab.sessionId).catch((err) =>
      log.warn('reload after crash failed', { tabId: tab.tabId, err }),
    );
  }

  private async refreshHistory(tab: Tab): Promise<void> {
    if (!tab.sessionId) return;
    try {
      const h = await this.cdp!.send<{ currentIndex: number; entries: unknown[] }>(
        'Page.getNavigationHistory',
        {},
        tab.sessionId,
      );
      tab.canGoBack = h.currentIndex > 0;
      tab.canGoForward = h.currentIndex < h.entries.length - 1;
    } catch {
      /* target may have gone */
    }
  }

  // --- operations ----------------------------------------------------------

  async navigate(tabId: string, rawUrl: string): Promise<void> {
    const tab = this.require(tabId);
    const url = normalizeUrl(rawUrl);
    if (!url) throw new Error('navigation_blocked');
    tab.loading = true;
    this.emit('tab.navigation', tab);
    await this.cdp!.send('Page.navigate', { url }, tab.sessionId);
  }

  async action(tabId: string, action: 'reload' | 'back' | 'forward' | 'stop' | 'duplicate'): Promise<Tab | void> {
    const tab = this.require(tabId);
    const s = tab.sessionId;
    switch (action) {
      case 'reload':
        return void (await this.cdp!.send('Page.reload', {}, s));
      case 'stop':
        return void (await this.cdp!.send('Page.stopLoading', {}, s));
      case 'duplicate':
        return this.createTab({ url: tab.url, label: tab.label, createdBy: tab.createdBy });
      case 'back':
      case 'forward': {
        const h = await this.cdp!.send<{ currentIndex: number; entries: { id: number }[] }>(
          'Page.getNavigationHistory',
          {},
          s,
        );
        const target = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
        if (!target) return;
        await this.cdp!.send('Page.navigateToHistoryEntry', { entryId: target.id }, s);
        return;
      }
    }
  }

  async close(tabId: string): Promise<void> {
    const tab = this.require(tabId);
    await this.cdp!.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    // Target.targetDestroyed normally removes it; do it eagerly for determinism.
    this.onTargetGone(tab.targetId);
  }

  /**
   * Apply a title reported by the page itself. Chromium only emits
   * Target.targetInfoChanged for navigations, so a single-page app that rewrites
   * document.title - "(3) Inbox" - would otherwise show a stale tab label.
   */
  setTitle(tabId: string, title: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.title === title) return;
    tab.title = title;
    updateTabMeta(tabId, tab.url, title);
    this.emit('tab.navigation', tab);
  }

  rename(tabId: string, label: string): Tab {
    const tab = this.require(tabId);
    tab.label = label.trim() || null;
    renameTab(tabId, tab.label);
    this.emit('tab.updated', tab);
    return tab;
  }

  /**
   * Set the zoom for a tab: the viewport becomes the base size divided by the
   * zoom, so content reflows larger (zoom in) or smaller (zoom out) while every
   * frame stays natively rendered rather than scaled.
   */
  async setZoom(tabId: string, zoom: number): Promise<Tab> {
    const tab = this.require(tabId);
    tab.zoom = Math.min(4, Math.max(0.25, zoom));
    return this.applyViewport(tab);
  }

  /** Change the streamed viewport. Callers restart the screencast afterwards. */
  async resize(tabId: string, width: number, height: number): Promise<Tab> {
    const tab = this.require(tabId);
    tab.baseWidth = width;
    tab.baseHeight = height;
    return this.applyViewport(tab);
  }

  /** Push base/zoom to Chromium, clamped to the configured maximum. */
  private async applyViewport(tab: Tab): Promise<Tab> {
    const tabId = tab.tabId;
    const width = Math.round(tab.baseWidth / tab.zoom);
    const height = Math.round(tab.baseHeight / tab.zoom);
    // Rounded to even numbers: an arbitrary zoom produces fractional sizes, and
    // odd dimensions can leave a one-pixel seam (JPEG chroma is sampled in 2x2
    // blocks) or be rounded by the window manager, which then no longer matches
    // the viewport.
    const even = (n: number) => n - (n % 2);
    // maxViewport(), not the configured maximum: on a headed browser the window
    // cannot exceed the screen, and a viewport that does is captured as black.
    const max = maxViewport();
    const w = even(Math.max(240, Math.min(width, max.width)));
    const h = even(Math.max(180, Math.min(height, max.height)));
    // Deliberately NOT recomputing zoom from the clamped size. Doing that fed a
    // derived value back into the input it was derived from: a resize would
    // re-read the clamped zoom, divide the new base by it, and the viewport would
    // walk away from the display area on every window change.
    if (w === tab.width && h === tab.height) {
      // Zoom may have changed even when clamping keeps the size (already at the
      // maximum), so clients still need the new value.
      this.emit('tab.updated', tab);
      return tab;
    }
    tab.width = w;
    tab.height = h;

    // Headed: resize the window to match. The screencast captures the window
    // surface, so a viewport smaller than its window shows as black padding and
    // a larger one is silently clamped - the two must stay equal.
    if (!config.headless) {
      try {
        const { windowId } = await this.cdp!.send<{ windowId: number }>('Browser.getWindowForTarget', {
          targetId: tab.targetId,
        });
        await this.cdp!.send('Browser.setWindowBounds', {
          windowId,
          bounds: { width: w, height: h, windowState: 'normal' },
        });
      } catch (err) {
        log.debug('window resize failed; frame may be padded or clamped', { tabId, err: err as Error });
      }
    }

    await this.cdp!.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: config.deviceScaleFactor, mobile: false },
      tab.sessionId,
    );
    this.emit('tab.resized', tab);
    return tab;
  }

  require(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('tab_not_found');
    if (!this.cdp?.connected || !tab.sessionId) throw new Error('browser_unavailable');
    return tab;
  }

  tabForSession(sessionId: string): Tab | undefined {
    const tabId = this.bySession.get(sessionId);
    return tabId ? this.tabs.get(tabId) : undefined;
  }
}
