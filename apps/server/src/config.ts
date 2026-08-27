/** Environment -> typed config. Read once at startup; nothing else reads env. */
import { existsSync } from 'node:fs';
import path from 'node:path';

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v);
const int = (v: string | undefined, dflt: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

/** Chromium binary: env override, then the usual per-platform locations. */
function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => existsSync(c)) ?? 'chromium';
}

const dataRoot = process.env.DATA_DIR || (existsSync('/data') ? '/data' : path.resolve('data'));

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: int(process.env.APP_PORT, 3030),
  host: process.env.SERVER_HOST || '0.0.0.0',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',

  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 168) * 3600_000,
  secureCookies: bool(process.env.SECURE_COOKIES, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',

  dataRoot,
  dbPath: (process.env.DATABASE_URL || `file:${path.join(dataRoot, 'app.db')}`).replace(/^file:/, ''),
  profileDir: process.env.CHROMIUM_DATA_DIR || path.join(dataRoot, 'profile'),
  downloadDir: process.env.DOWNLOAD_DIR || path.join(dataRoot, 'downloads'),
  uploadDir: process.env.UPLOAD_DIR || path.join(dataRoot, 'uploads'),
  /** Unpacked Chromium extensions live here, one directory each. */
  extensionsDir: process.env.EXTENSIONS_DIR || path.join(dataRoot, 'extensions'),
  extensionsEnabled: bool(process.env.EXTENSIONS_ENABLED, true),

  /**
   * Page a new tab opens, and what the browser starts on. Kept as about:blank by
   * default so a fresh deployment needs no Internet access at all; set it to a
   * real URL (a search engine, an intranet dashboard) to get a home page.
   */
  homeUrl: process.env.HOME_URL || 'about:blank',

  chromiumPath: findChromium(),
  headless: bool(process.env.CHROMIUM_HEADLESS, true),
  cdpPort: int(process.env.CDP_PORT, 9222),
  chromiumSandbox: bool(process.env.CHROMIUM_SANDBOX, false),
  locale: process.env.CHROMIUM_LOCALE || 'en-US',
  timezone: process.env.CHROMIUM_TIMEZONE || 'UTC',

  viewport: {
    width: int(process.env.VIEWPORT_WIDTH, 1280),
    height: int(process.env.VIEWPORT_HEIGHT, 720),
    maxWidth: int(process.env.MAX_VIEWPORT_WIDTH, 1920),
    maxHeight: int(process.env.MAX_VIEWPORT_HEIGHT, 1080),
  },
  /**
   * The virtual screen a headed Chromium's windows live on, from XVFB_GEOMETRY.
   *
   * Load-bearing: a window cannot be larger than its screen, and a screencast of
   * a viewport larger than its window is returned black. Zooming out grows the
   * viewport, so without this the picture went black at 50% - measured. The
   * entrypoint derives the geometry from MAX_VIEWPORT_*, and this parses whatever
   * it ended up being so the clamp is honest rather than assumed.
   */
  display: (() => {
    const [w, h] = (process.env.XVFB_GEOMETRY ?? '').split('x');
    return {
      width: int(w, int(process.env.MAX_VIEWPORT_WIDTH, 1920)),
      height: int(h, int(process.env.MAX_VIEWPORT_HEIGHT, 1080)),
    };
  })(),
  /**
   * Ignore the size each client asks for and always stream VIEWPORT_WIDTH x
   * VIEWPORT_HEIGHT. Useful when the biggest client window is smaller than the
   * resolution you want to browse at: the frame is then scaled down to fit,
   * which shows more of the page and looks sharper on a HiDPI screen. The cost
   * is that small clients still receive full-size frames.
   */
  pinViewport: bool(process.env.PIN_VIEWPORT, false),
  /**
   * devicePixelRatio the page sees. Note this does NOT raise the stream's
   * resolution: CDP screencast captures at the CSS viewport size in DIP, so the
   * frame stays the same pixel count whatever this is set to (measured). It only
   * changes which assets responsive sites choose to serve. Use PAGE_ZOOM plus a
   * larger VIEWPORT to get genuinely more pixels.
   */
  deviceScaleFactor: Math.min(3, Math.max(1, Number(process.env.DEVICE_SCALE_FACTOR ?? 1) || 1)),

  maxFps: int(process.env.MAX_FPS, 30),
  streamQuality: Math.min(100, Math.max(1, int(process.env.STREAM_QUALITY, 70))),
  backpressureBytes: int(process.env.BACKPRESSURE_BYTES, 256 * 1024),

  maxTabs: int(process.env.MAX_TABS, 20),
  maxUsers: int(process.env.MAX_USERS, 50),
  maxMessageRate: int(process.env.MAX_MESSAGE_RATE, 200),
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,

  /**
   * Permission a plain `user` gets on a tab with no explicit grant. 'control'
   * makes the browser shared-by-default (the LAN use case); set 'view' for a
   * deployment where an admin must hand out control per tab.
   */
  defaultTabPermission: (process.env.DEFAULT_TAB_PERMISSION === 'view' ? 'view' : 'control') as 'view' | 'control',
  /**
   * A tab belongs to whoever opened it: they control it, everyone else watches
   * until granted otherwise (and can ask for it in the UI).
   *
   * Off restores the older behaviour, where any tab is everybody's to drive -
   * which is the right default for a small trusted group sharing one screen, and
   * the wrong one the moment somebody is doing something they would rather not
   * have typed into.
   */
  tabOwnership: process.env.TAB_OWNERSHIP !== 'false' && process.env.TAB_OWNERSHIP !== '0',

  clipboardEnabled: bool(process.env.CLIPBOARD_ENABLED, true),
  downloadsEnabled: bool(process.env.DOWNLOADS_ENABLED, true),
  uploadsEnabled: bool(process.env.UPLOADS_ENABLED, true),
  metricsEnabled: bool(process.env.METRICS_ENABLED, true),
  /**
   * Chrome DevTools for admins, proxied through this server. Off by default:
   * it is a raw CDP channel to a page, which can run arbitrary JavaScript and
   * read that page's cookies. See api/devtools.ts and docs/security.md.
   */
  devtoolsEnabled: bool(process.env.DEVTOOLS_ENABLED, false),

  mdnsEnabled: bool(process.env.MDNS_ENABLED, true),
  mdnsHostname: (process.env.MDNS_HOSTNAME || 'shared-browser').replace(/\.local$/, ''),

  webrtcEnabled: bool(process.env.WEBRTC_ENABLED, false),
  stunServer: process.env.STUN_SERVER || '',
  turnServer: process.env.TURN_SERVER || '',

  webRoot: process.env.WEB_ROOT || '',
} as const;

export type Config = typeof config;

/** Loud, non-fatal warnings for footguns that only matter in production. */
export function configWarnings(): string[] {
  const w: string[] = [];
  if (config.isProd && config.sessionSecret.startsWith('dev-insecure'))
    w.push('SESSION_SECRET is unset - sessions are signed with a well-known key.');
  if (config.isProd && config.adminPassword === 'changeme')
    w.push('ADMIN_PASSWORD is still "changeme".');
  if (config.trustedOrigins.length === 0 && config.isProd)
    w.push('TRUSTED_ORIGINS empty - only same-origin and private-range Origins are accepted.');
  return w;
}
