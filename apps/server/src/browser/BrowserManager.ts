/**
 * Owns the Chromium process and the single CDP connection to it.
 *
 * One Chromium, one profile, one shared browser environment - so a login in tab
 * 1 is visible to tab 2 exactly as it would be in a desktop browser. Per-user
 * isolation would be a BrowserContext per user (Target.createBrowserContext);
 * the seam for that is `createTarget`'s optional browserContextId, unused today.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { id } from '../ids.js';
import { recordBrowserStart, recordBrowserStatus } from '../db.js';
import { CdpConnection, discoverEndpoint, readActivePortEndpoint } from './cdp.js';
import { clearStaleProfileLocks } from './profile.js';
import { ensureExtensionsDir, extensionArgs } from './extensions.js';
import type { BrowserStatus } from '@orbit/protocol';

export interface BrowserManagerEvents {
  status: (status: BrowserStatus, message?: string) => void;
  /** A fresh CDP connection is live: managers must re-attach their state. */
  connected: (cdp: CdpConnection) => void;
  disconnected: () => void;
}

/**
 * Below this, Chromium's shared memory has to be redirected to /tmp with
 * --disable-dev-shm-usage. Docker's default /dev/shm is 64MB, which is far too
 * small; this project provisions 1GB, and using it is what keeps image-heavy
 * pages from exhausting the general-purpose tmpfs and crashing the renderer.
 */
const MIN_DEV_SHM_BYTES = 256 * 1024 * 1024;

function devShmTooSmall(): boolean {
  try {
    const st = statfsSync('/dev/shm');
    return Number(st.bsize) * Number(st.blocks) < MIN_DEV_SHM_BYTES;
  } catch {
    return true; // no /dev/shm at all (macOS) - keep the workaround
  }
}

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 60_000;
const RESTART_GIVEUP = 8;

export class BrowserManager extends EventEmitter {
  readonly browserId = id('brw');
  private proc: ChildProcess | null = null;
  private cdpConn: CdpConnection | null = null;
  private _status: BrowserStatus = 'stopped';
  private restartCount = 0;
  private consecutiveFailures = 0;
  private startedAt: number | null = null;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  /** http://127.0.0.1:<port> for the live CDP endpoint, or null when down. */
  private httpBase: string | null = null;

  /**
   * Loopback base URL of Chromium's DevTools HTTP server. Derived from the
   * resolved websocket endpoint, so it is correct even when CDP_PORT is 0 and
   * the port was assigned by the OS.
   */
  get cdpHttpBase(): string | null {
    return this.isReady ? this.httpBase : null;
  }

  get status(): BrowserStatus {
    return this._status;
  }
  get restarts(): number {
    return this.restartCount;
  }
  get startTime(): number | null {
    return this.startedAt;
  }
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * Called by the runtime once the tab session has been rebuilt on top of a
   * fresh connection. Until then the browser is up but not yet usable.
   */
  markReady(): void {
    if (!this.cdpConn?.connected) return;
    this.setStatus('running');
  }

  /** The live CDP connection. Throws when the browser is not currently usable. */
  get cdp(): CdpConnection {
    if (!this.cdpConn?.connected) throw new Error('browser_unavailable');
    return this.cdpConn;
  }
  get isReady(): boolean {
    return this._status === 'running' && !!this.cdpConn?.connected;
  }

  private setStatus(s: BrowserStatus, message?: string) {
    if (this._status === s && !message) return;
    this._status = s;
    recordBrowserStatus(this.browserId, s);
    log.info('browser status', { browserId: this.browserId, status: s, ...(message ? { message } : {}) });
    this.emit('status', s, message);
  }

  private chromiumArgs(): string[] {
    const args = [
      `--remote-debugging-port=${config.cdpPort}`,
      // Bind CDP to loopback only: it is reachable from this process and
      // nothing else, even inside the container. See docs/security.md.
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${config.profileDir}`,
      `--window-size=${config.viewport.maxWidth},${config.viewport.maxHeight}`,
      `--lang=${config.locale}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--force-color-profile=srgb',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AcceptCHFrame',
      // These four are load-bearing for the product: without them Chromium
      // throttles or stops compositing tabs that are not in the foreground, and
      // users on other tabs would see a frozen stream.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      // We deliberately send high-rate input over CDP.
      '--disable-ipc-flooding-protection',
      // Chromium's initial page is adopted as the first tab, so start it on the
      // configured home rather than about:blank.
      config.homeUrl,
    ];
    // Only redirect shared memory to /tmp when /dev/shm is genuinely too small:
    // doing it unconditionally trades a 1GB purpose-built mount for a smaller
    // shared one, and image-heavy pages then crash the renderer.
    // Extensions are fixed at launch, so this is where they are picked up; the
    // API tells admins a restart is needed after a change.
    args.push(...extensionArgs());

    if (devShmTooSmall()) {
      log.warn('/dev/shm is small - redirecting Chromium shared memory to /tmp', { hint: 'raise shm_size' });
      args.push('--disable-dev-shm-usage');
    }
    if (config.headless) args.unshift('--headless=new');
    if (!config.chromiumSandbox) args.unshift('--no-sandbox', '--disable-setuid-sandbox');
    return args;
  }

  /**
   * Drop stale profile locks before launching. Safe because the only Chromium
   * that ever owns this profile is our own child, which is not running here.
   */
  private clearProfileLocks(): void {
    if (this.proc && this.proc.exitCode === null) return; // our child is alive
    try {
      for (const file of clearStaleProfileLocks(config.profileDir))
        log.warn('removed stale chromium profile lock', { file });
    } catch (err) {
      log.error('could not clear profile locks - chromium may refuse to start', { err: err as Error });
    }
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    mkdirSync(config.profileDir, { recursive: true });
    mkdirSync(config.downloadDir, { recursive: true });
    mkdirSync(config.uploadDir, { recursive: true });
    ensureExtensionsDir();
    this.clearProfileLocks();
    // A stale port file would point this process at a Chromium that is already
    // gone (or worse, someone else's).
    rmSync(path.join(config.profileDir, 'DevToolsActivePort'), { force: true });
    this.setStatus(this.restartCount === 0 ? 'starting' : 'restarting');

    const args = this.chromiumArgs();
    log.info('launching chromium', {
      browserId: this.browserId,
      bin: config.chromiumPath,
      headless: config.headless,
      profile: config.profileDir,
    });

    const proc = spawn(config.chromiumPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TZ: config.timezone, LANG: `${config.locale.replace('-', '_')}.UTF-8` },
      detached: false,
    });
    this.proc = proc;

    proc.stderr?.on('data', (b: Buffer) => {
      const line = b.toString().trim();
      // Chromium is extremely chatty on stderr; only surface real problems.
      if (/ERROR|FATAL|Fontconfig error|crash/i.test(line)) log.debug('chromium', { line: line.slice(0, 400) });
    });
    proc.on('exit', (code, signal) => this.onProcessExit(code, signal));
    proc.on('error', (err) => {
      log.error('chromium spawn failed', { err, bin: config.chromiumPath });
      this.setStatus('crashed', `cannot launch ${config.chromiumPath}`);
    });

    // Port 0 means "let the OS pick": Chromium then reports the real port in
    // DevToolsActivePort. A fixed port is the default because it is easier to
    // reason about, but 0 is what makes concurrent instances safe.
    const endpoint =
      config.cdpPort === 0 ? await readActivePortEndpoint(config.profileDir) : await discoverEndpoint(config.cdpPort);
    try {
      const parsed = new URL(endpoint);
      this.httpBase = `http://${parsed.host}`;
    } catch {
      this.httpBase = null;
    }
    const conn = new CdpConnection(endpoint);
    await conn.connect();
    this.cdpConn = conn;

    conn.once('disconnected', () => {
      if (this.shuttingDown) return;
      log.warn('cdp disconnected', { browserId: this.browserId });
      this.emit('disconnected');
      this.scheduleRestart('cdp disconnected');
    });

    if (config.downloadsEnabled) {
      await conn
        .send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: config.downloadDir,
          eventsEnabled: true,
        })
        .catch((err) => log.warn('download behaviour not set', { err }));
    }

    const version = await conn.send<{ product: string }>('Browser.getVersion');
    this.startedAt = Date.now();
    this.consecutiveFailures = 0;
    recordBrowserStart(this.browserId);
    log.info('chromium process ready', { browserId: this.browserId, product: version.product, pid: proc.pid });
    // Status stays 'starting'/'restarting' until the tab session has been
    // rebuilt: clients act on 'running' by re-subscribing, and announcing it
    // while TabManager is still restoring would race every one of them.
    this.emit('connected', conn);
  }

  private onProcessExit(code: number | null, signal: string | null) {
    this.proc = null;
    this.cdpConn?.close();
    this.cdpConn = null;
    if (this.shuttingDown) {
      this.setStatus('stopped');
      return;
    }
    log.error('chromium exited unexpectedly', { browserId: this.browserId, code, signal });
    this.emit('disconnected');
    this.scheduleRestart(`exit code=${code} signal=${signal}`);
  }

  /**
   * Exponential backoff so a Chromium that cannot start (bad profile, missing
   * library) does not turn into a hot restart loop pinning a CPU core.
   */
  private scheduleRestart(reason: string) {
    if (this.shuttingDown || this.restartTimer) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures > RESTART_GIVEUP) {
      this.setStatus('crashed', 'browser failed to start repeatedly - manual intervention needed');
      log.error('giving up on chromium restarts', { attempts: this.consecutiveFailures, reason });
      return;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** (this.consecutiveFailures - 1), RESTART_MAX_MS);
    this.setStatus('restarting', reason);
    log.warn('scheduling chromium restart', { delayMs: delay, attempt: this.consecutiveFailures, reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartCount++;
      this.start().catch((err) => {
        log.error('restart failed', { err });
        this.scheduleRestart('restart failed');
      });
    }, delay);
  }

  /** Admin-triggered restart. Profile on disk is what carries state across it. */
  async restart(): Promise<void> {
    log.warn('operator requested browser restart', { browserId: this.browserId });
    this.consecutiveFailures = 0;
    await this.killProcess();
    // onProcessExit schedules the restart; wait for it to come back ready.
    await this.waitUntilReady(45_000);
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isReady) return true;
      if (this._status === 'crashed') return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.isReady;
  }

  private async killProcess(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    // Ask Chromium to close itself first so it flushes the profile (cookies,
    // localStorage) cleanly; SIGKILL can leave a corrupt profile behind.
    try {
      if (this.cdpConn?.connected) await this.cdpConn.send('Browser.close', {}, undefined, 5000);
    } catch {
      /* fall through to signals */
    }
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn('chromium did not exit; SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 8000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /** Graceful shutdown: no restart, profile flushed. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.killProcess();
    this.cdpConn?.close();
    this.cdpConn = null;
    this.setStatus('stopped');
  }
}
