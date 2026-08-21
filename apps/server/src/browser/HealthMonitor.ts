/**
 * Liveness probe for Chromium.
 *
 * A crashed process is caught by the child 'exit' handler in BrowserManager.
 * This catches the nastier case: the process is alive but the browser is wedged
 * (renderer deadlock, CDP not answering). One cheap Browser.getVersion round
 * trip per interval is enough to tell the difference.
 */
import { log } from '../log.js';
import type { BrowserManager } from './BrowserManager.js';

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private lastLatencyMs = 0;

  constructor(
    private readonly browser: BrowserManager,
    private readonly intervalMs = 10_000,
    private readonly failureThreshold = 3,
  ) {}

  get cdpLatencyMs(): number {
    return this.lastLatencyMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async probe(): Promise<void> {
    if (this.browser.status !== 'running') return;
    const started = Date.now();
    try {
      await this.browser.cdp.send('Browser.getVersion', {}, undefined, 5000);
      this.lastLatencyMs = Date.now() - started;
      if (this.consecutiveFailures) log.info('browser health recovered', { after: this.consecutiveFailures });
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      log.warn('browser health probe failed', { attempt: this.consecutiveFailures, err: err as Error });
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.consecutiveFailures = 0;
        log.error('browser unresponsive - restarting');
        await this.browser.restart().catch((e) => log.error('health restart failed', { err: e }));
      }
    }
  }
}
