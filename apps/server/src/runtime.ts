/**
 * Composition root: builds the browser subsystem and holds the wiring between
 * managers so nothing else has to know the object graph.
 *
 * Also owns the two browser-level integrations that do not belong to any single
 * manager: file chooser interception and download notifications.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { TabInfo } from '@orbit/protocol';
import { config } from './config.js';
import { log } from './log.js';
import { Metrics } from './metrics.js';
import { BrowserManager } from './browser/BrowserManager.js';
import { TabManager, type Tab } from './browser/TabManager.js';
import { InputManager } from './browser/InputManager.js';
import { StreamManager } from './browser/StreamManager.js';
import { CookieManager } from './browser/CookieManager.js';
import { HealthMonitor } from './browser/HealthMonitor.js';
import type { CdpEvent } from './browser/cdp.js';
import type { Hub } from './ws/hub.js';

/**
 * Injected into every page. Two jobs, both of which need to run inside the page:
 * report copies (so the client clipboard can follow) and report document.title
 * changes (which CDP does not announce outside of navigations).
 */
const PAGE_HOOK = `
(() => {
  if (window.__cbHooked) return;
  window.__cbHooked = true;

  const copy = () => {
    try {
      const text = (document.getSelection() || '').toString();
      if (text && window.__cbClipboard) window.__cbClipboard(JSON.stringify({ text: text.slice(0, 65536) }));
    } catch (_) {}
  };
  document.addEventListener('copy', copy, true);
  document.addEventListener('cut', copy, true);

  let last = null;
  const reportTitle = () => {
    try {
      const title = document.title || '';
      if (title === last || !window.__cbTitle) return;
      last = title;
      window.__cbTitle(JSON.stringify({ title: title.slice(0, 300) }));
    } catch (_) {}
  };
  // The <title> node is replaced wholesale by some frameworks, so watch <head>
  // as well as the text inside the current title element.
  const observe = () => {
    if (!document.head) return false;
    new MutationObserver(reportTitle).observe(document.head, { childList: true, subtree: true, characterData: true });
    return true;
  };
  // This script runs at document-start, when <head> does not exist and the title
  // is still empty. Reporting only here (or only when the observer attaches)
  // means the real title - parsed moments later - is never sent, so report at
  // every stage as well as on mutation.
  reportTitle();
  if (!observe()) document.addEventListener('DOMContentLoaded', () => { observe(); reportTitle(); }, { once: true });
  document.addEventListener('DOMContentLoaded', reportTitle, { once: true });
  window.addEventListener('load', reportTitle, { once: true });
  setTimeout(reportTitle, 250);
  setTimeout(reportTitle, 1500);
})();
`;

interface PendingChooser {
  backendNodeId: number;
  sessionId: string;
  at: number;
}

export class Runtime extends EventEmitter {
  readonly browser = new BrowserManager();
  readonly tabs = new TabManager(this.browser);
  readonly streams = new StreamManager(this.tabs);
  readonly input: InputManager;
  readonly cookies = new CookieManager(() => this.browser.cdp);
  readonly health = new HealthMonitor(this.browser);
  readonly metrics: Metrics;
  private hub: Hub | null = null;
  private pendingChoosers = new Map<string, PendingChooser>();

  constructor() {
    super();
    this.input = new InputManager(
      this.tabs,
      () => this.browser.cdp,
      (r) => this.hub?.onInputDispatched(r),
    );
    this.metrics = new Metrics(this.tabs, this.streams, this.input);

    this.browser.on('connected', (cdp) => {
      void (async () => {
        try {
          this.input.rebind(() => this.browser.cdp);
          cdp.on('Browser.downloadWillBegin', (e: CdpEvent) => this.onDownloadStart(e));
          cdp.on('Browser.downloadProgress', (e: CdpEvent) => this.onDownloadProgress(e));
          cdp.on('Page.fileChooserOpened', (e: CdpEvent) => this.onFileChooser(e));
          cdp.on('Runtime.bindingCalled', (e: CdpEvent) => this.onBinding(e));
          // Tabs first: re-arming streams before the page sessions exist would
          // start screencasts against the dead sessions of the old browser.
          await this.tabs.attach(cdp);
          this.streams.attach(cdp);
          this.health.start();
        } finally {
          // Announce 'running' only now, when a subscribe can actually succeed.
          this.browser.markReady();
        }
      })().catch((err) => log.error('post-connect wiring failed', { err }));
    });
  }

  bindHub(hub: Hub): void {
    this.hub = hub;
  }

  tabInfo(tab: Tab): TabInfo {
    return this.tabs.info(tab, this.streams.viewers(tab.tabId));
  }

  /** Per-page optional features. Re-applied on every attach, including recovery. */
  async installPageHooks(tab: Tab): Promise<void> {
    if (!tab.sessionId) return;
    const cdp = this.browser.cdp;
    try {
      if (config.clipboardEnabled) await cdp.send('Runtime.addBinding', { name: '__cbClipboard' }, tab.sessionId);
      await cdp.send('Runtime.addBinding', { name: '__cbTitle' }, tab.sessionId);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOK }, tab.sessionId);
      // Also arm the document that is already loaded.
      await cdp.send('Runtime.evaluate', { expression: PAGE_HOOK, silent: true }, tab.sessionId).catch(() => {});
    } catch (err) {
      log.debug('page hooks not installed', { tabId: tab.tabId, err: err as Error });
    }
  }

  private onBinding(e: CdpEvent): void {
    const name = e.params.name as string;
    if (name !== '__cbClipboard' && name !== '__cbTitle') return;
    const tab = this.tabs.tabForSession(e.sessionId ?? '');
    if (!tab) return;
    try {
      const payload = JSON.parse(e.params.payload as string) as { text?: string; title?: string };
      if (name === '__cbTitle') {
        if (typeof payload.title === 'string') this.tabs.setTitle(tab.tabId, payload.title);
        return;
      }
      // Never logged - this is page content and possibly a password.
      if (payload.text) this.emit('clipboard', { tabId: tab.tabId, text: payload.text });
    } catch {
      /* ignore malformed payload */
    }
  }

  private onFileChooser(e: CdpEvent): void {
    const tab = this.tabs.tabForSession(e.sessionId ?? '');
    if (!tab) return;
    this.pendingChoosers.set(tab.tabId, {
      backendNodeId: e.params.backendNodeId,
      sessionId: e.sessionId!,
      at: Date.now(),
    });
    log.info('file chooser opened', { tabId: tab.tabId, mode: e.params.mode });
    this.emit('file.chooser', {
      tabId: tab.tabId,
      multiple: e.params.mode === 'selectMultiple',
      accept: [],
    });
  }

  /**
   * Attach previously uploaded files to the page's file input.
   *
   * Only names inside UPLOAD_DIR are accepted, and path separators are stripped:
   * the page must never be able to reach an arbitrary path on the container.
   */
  async respondToFileChooser(tabId: string, files: string[]): Promise<void> {
    const pending = this.pendingChoosers.get(tabId);
    if (!pending) throw new Error('tab_not_found');
    this.pendingChoosers.delete(tabId);
    const paths: string[] = [];
    for (const name of files) {
      const safe = path.basename(name);
      const full = path.join(config.uploadDir, safe);
      if (!full.startsWith(path.resolve(config.uploadDir) + path.sep) && path.dirname(full) !== path.resolve(config.uploadDir))
        continue;
      if (existsSync(full)) paths.push(full);
    }
    const cdp = this.browser.cdp;
    await cdp.send('DOM.enable', {}, pending.sessionId).catch(() => {});
    await cdp.send('DOM.setFileInputFiles', { files: paths, backendNodeId: pending.backendNodeId }, pending.sessionId);
    log.info('file chooser answered', { tabId, files: paths.length });
  }

  private onDownloadStart(e: CdpEvent): void {
    // downloadWillBegin identifies the initiating frame, not the target; a
    // download is a browser-level event so it is announced without a tabId.
    this.emit('download', {
      tabId: null,
      state: 'started' as const,
      guid: e.params.guid,
      fileName: e.params.suggestedFilename ?? 'download',
    });
    log.info('download started', { guid: e.params.guid, file: e.params.suggestedFilename });
  }

  private onDownloadProgress(e: CdpEvent): void {
    const state = e.params.state as 'inProgress' | 'completed' | 'canceled';
    this.emit('download', {
      tabId: null,
      state: state === 'inProgress' ? ('progress' as const) : (state as 'completed' | 'canceled'),
      guid: e.params.guid,
      fileName: '',
      received: e.params.receivedBytes,
      total: e.params.totalBytes,
    });
  }

  /**
   * What is under the pointer, for the client's context menu.
   *
   * Evaluated on demand rather than tracked continuously: it is needed once per
   * right-click, and watching every mouse move would mean a round trip per
   * pixel.
   */
  async probeContext(
    tabId: string,
    x: number,
    y: number,
  ): Promise<{ link: string | null; image: string | null; selection: string }> {
    const tab = this.tabs.require(tabId);
    const expression = `(() => {
      const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      const anchor = el && el.closest ? el.closest('a[href]') : null;
      const img = el && el.tagName === 'IMG' ? el : (el && el.querySelector ? el.querySelector('img') : null);
      return JSON.stringify({
        link: anchor ? anchor.href : null,
        image: img ? img.currentSrc || img.src : null,
        // Bounded, but generously: this text is what the menu's Copy puts on
        // the clicking user's clipboard. A copy larger than this still arrives
        // in full, via the page's own copy event.
        selection: String(document.getSelection() || '').slice(0, 8192),
      });
    })()`;
    const res = await this.browser.cdp.send<{ result: { value?: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, timeout: 2000 },
      tab.sessionId,
    );
    try {
      const parsed = JSON.parse(res.result.value ?? '{}') as { link?: string; image?: string; selection?: string };
      return { link: parsed.link ?? null, image: parsed.image ?? null, selection: parsed.selection ?? '' };
    } catch {
      return { link: null, image: null, selection: '' };
    }
  }

  async start(): Promise<void> {
    await this.browser.start();
  }

  async shutdown(): Promise<void> {
    this.health.stop();
    await this.streams.stopAll();
    await this.browser.shutdown();
  }
}
