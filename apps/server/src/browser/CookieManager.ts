/**
 * Browser-wide cookie/storage helpers.
 *
 * The point of a *shared* browser is that these are not per-user: state lives in
 * one Chromium profile on a Docker volume, so a login in one tab is a login for
 * everyone, exactly like a desktop browser. This module exists so that
 * inspection and clearing go through one audited place instead of ad-hoc CDP
 * calls scattered through route handlers.
 */
import { log } from '../log.js';
import type { CdpConnection } from './cdp.js';

export interface CookieSummary {
  domain: string;
  count: number;
  sessionCookies: number;
}

export class CookieManager {
  constructor(private readonly cdp: () => CdpConnection) {}

  /**
   * Per-domain counts only. Cookie *values* are credentials: they are never
   * returned to a client or written to a log.
   */
  async summarize(): Promise<CookieSummary[]> {
    const { cookies } = await this.cdp().send<{ cookies: { domain: string; session: boolean }[] }>(
      'Storage.getCookies',
      {},
    );
    const byDomain = new Map<string, CookieSummary>();
    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, '');
      const entry = byDomain.get(domain) ?? { domain, count: 0, sessionCookies: 0 };
      entry.count++;
      if (c.session) entry.sessionCookies++;
      byDomain.set(domain, entry);
    }
    return [...byDomain.values()].sort((a, b) => b.count - a.count);
  }

  /** Admin action: sign the shared browser out of everything. */
  async clearAll(): Promise<void> {
    await this.cdp().send('Storage.clearCookies', {});
    log.warn('all browser cookies cleared');
  }

  async clearDomain(domain: string): Promise<void> {
    const { cookies } = await this.cdp().send<{ cookies: { name: string; domain: string; path: string }[] }>(
      'Storage.getCookies',
      {},
    );
    const doomed = cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(domain));
    for (const c of doomed) {
      await this.cdp()
        .send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path })
        .catch(() => {});
    }
    log.warn('cookies cleared for domain', { domain, removed: doomed.length });
  }
}
