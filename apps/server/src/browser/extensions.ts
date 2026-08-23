/**
 * Chromium extensions, loaded unpacked from a directory on the data volume.
 *
 * Unpacked is the only form Chromium takes at launch, so both install routes end
 * up in the same place: an admin uploads a zip, or names a Web Store id and the
 * .crx is fetched from Google's update service and unwrapped (see
 * downloadFromWebStore). Neither is signature-verified - the trust boundary is
 * the admin, and every install is audited.
 *
 * Extensions are process-wide: Chromium takes --load-extension at launch, so a
 * change needs a browser restart. That is deliberate rather than hidden - the
 * API reports it and the admin decides when to restart.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

export interface InstalledExtension {
  /** Directory name under EXTENSIONS_DIR - the handle used by the API. */
  id: string;
  /** Absolute path passed to Chromium (may be one level in, see below). */
  loadPath: string;
  name: string;
  version: string;
  manifestVersion: number;
  permissions: string[];
  sizeBytes: number;
  /** Chromium's own id for the extension, i.e. the chrome-extension:// host. */
  chromeId: string;
  /** Toolbar popup page, if the extension has one. */
  popupPath: string | null;
  /** Options page, if the extension has one. */
  optionsPath: string | null;
}

/**
 * Chromium's id for an extension: the first 128 bits of a SHA-256, rewritten in
 * the a-p alphabet Chromium uses so ids are never mistaken for hex.
 *
 * The hash is over the public key when the manifest ships one, and over the
 * absolute load path otherwise - which is what makes an unpacked extension's id
 * stable across restarts as long as the directory does not move.
 */
export function extensionId(loadPath: string, manifestKey?: string): string {
  const source = manifestKey ? Buffer.from(manifestKey, 'base64') : Buffer.from(loadPath, 'utf8');
  return createHash('sha256')
    .update(source)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));
}

/**
 * Resolve a "__MSG_extName__" placeholder against the extension's own messages.
 *
 * Store extensions are localised, so the manifest usually carries a placeholder
 * rather than a name. Chromium resolves it from _locales; without doing the same
 * the list would read "__MSG_extName__" for half the extensions installed.
 */
function resolveMessage(value: string, loadPath: string, defaultLocale: string | undefined): string {
  const key = /^__MSG_(.+)__$/.exec(value)?.[1];
  if (!key) return value;
  for (const locale of [defaultLocale, 'en', 'en_US'].filter(Boolean) as string[]) {
    try {
      const messages = JSON.parse(readFileSync(path.join(loadPath, '_locales', locale, 'messages.json'), 'utf8')) as
        | Record<string, { message?: string }>
        | undefined;
      const message = messages?.[key]?.message;
      if (message) return message;
    } catch {
      /* no such locale, try the next */
    }
  }
  return value;
}

/** Strip a leading slash and any query, so the path can be appended to a host. */
const pagePath = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.replace(/^\/+/, '') : null;

/** A zip often contains a single wrapper folder; accept one level of nesting. */
function findManifestDir(dir: string): string | null {
  if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return null;
  }
  return entries.find((sub) => existsSync(path.join(sub, 'manifest.json'))) ?? null;
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          total += statSync(p).size;
        } catch {
          /* vanished mid-walk */
        }
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable */
  }
  return total;
}

export function ensureExtensionsDir(): void {
  mkdirSync(config.extensionsDir, { recursive: true });
}

export function listExtensions(): InstalledExtension[] {
  if (!config.extensionsEnabled) return [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(config.extensionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: InstalledExtension[] = [];
  for (const id of dirs) {
    const root = path.join(config.extensionsDir, id);
    const loadPath = findManifestDir(root);
    if (!loadPath) {
      log.warn('ignoring extension directory with no manifest.json', { id });
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(path.join(loadPath, 'manifest.json'), 'utf8')) as {
        name?: string;
        version?: string;
        manifest_version?: number;
        permissions?: string[];
        key?: string;
        default_locale?: string;
        action?: { default_popup?: string };
        browser_action?: { default_popup?: string };
        page_action?: { default_popup?: string };
        options_page?: string;
        options_ui?: { page?: string };
      };
      out.push({
        id,
        loadPath,
        name:
          typeof manifest.name === 'string' ? resolveMessage(manifest.name, loadPath, manifest.default_locale) : id,
        version: typeof manifest.version === 'string' ? manifest.version : '?',
        manifestVersion: Number(manifest.manifest_version ?? 0),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions.slice(0, 40).map(String) : [],
        sizeBytes: directorySize(root),
        chromeId: extensionId(loadPath, typeof manifest.key === 'string' ? manifest.key : undefined),
        popupPath:
          pagePath(manifest.action?.default_popup) ??
          pagePath(manifest.browser_action?.default_popup) ??
          pagePath(manifest.page_action?.default_popup),
        optionsPath: pagePath(manifest.options_page) ?? pagePath(manifest.options_ui?.page),
      });
    } catch (err) {
      log.warn('extension manifest could not be read', { id, err: err as Error });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Chromium launch flags. Empty when there is nothing installed. */
export function extensionArgs(): string[] {
  const installed = listExtensions();
  if (installed.length === 0) return [];
  const paths = installed.map((e) => e.loadPath).join(',');
  log.info('loading extensions', { count: installed.length, names: installed.map((e) => e.name) });
  // --disable-extensions-except pins the set to exactly what is installed here,
  // so nothing left in the profile from an earlier run loads unnoticed.
  return [`--disable-extensions-except=${paths}`, `--load-extension=${paths}`];
}

/**
 * Install straight from the Chrome Web Store.
 *
 * The store has no public download API; what it has is the update service every
 * Chrome install talks to, which answers with a .crx for a given extension id.
 * A .crx is a short signed header followed by an ordinary zip, so this fetches
 * one, drops the header and hands the zip to the same unpacking path as an
 * uploaded file.
 *
 * What this does NOT do, and should not be mistaken for: verify the signature,
 * or keep the extension up to date. It is the same trust level as an admin
 * uploading a zip - the code is unreviewed and runs in the shared browser.
 *
 * The unpacked extension also gets a path-derived id rather than its store id
 * (the id in the signed header), so an extension that hardcodes its own id -
 * OAuth redirect URIs, mainly - can misbehave.
 */
export async function downloadFromWebStore(storeId: string, chromeVersion: string): Promise<Buffer> {
  if (!/^[a-p]{32}$/.test(storeId)) throw new Error('bad_store_id');
  const url =
    'https://clients2.google.com/service/update2/crx' +
    `?response=redirect&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(chromeVersion)}` +
    `&x=${encodeURIComponent(`id=${storeId}&installsource=ondemand&uc`)}`;

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`store_http_${res.status}`);
  const crx = Buffer.from(await res.arrayBuffer());
  return crxToZip(crx);
}

/**
 * Strip a .crx wrapper, leaving the zip.
 *
 * CRX3: "Cr24", version 3, header length, protobuf header, then the zip. CRX2
 * (still what a few old extensions serve) instead carries a public key length
 * and a signature length. Both are handled because the store decides which one
 * it sends, not us.
 */
export function crxToZip(crx: Buffer): Buffer {
  if (crx.subarray(0, 4).toString() !== 'Cr24') {
    // Some responses are already a plain zip.
    if (crx.subarray(0, 2).toString() === 'PK') return crx;
    throw new Error('not_a_crx');
  }
  const version = crx.readUInt32LE(4);
  if (version === 3) {
    const headerLength = crx.readUInt32LE(8);
    const start = 12 + headerLength;
    if (headerLength <= 0 || start > crx.length) throw new Error('bad_crx3_header');
    return crx.subarray(start);
  }
  if (version === 2) {
    const start = 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
    if (start > crx.length) throw new Error('bad_crx2_header');
    return crx.subarray(start);
  }
  throw new Error(`unsupported_crx_version_${version}`);
}

/**
 * The store id out of a URL or a bare id, so a user can paste either.
 * e.g. https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh
 */
export function parseStoreId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed;
  const match = /([a-p]{32})/.exec(trimmed);
  return match ? match[1]! : null;
}

/** Remove an installed extension. Returns false when the id is unknown. */
export function removeExtension(id: string): boolean {
  const safe = path.basename(id);
  const dir = path.join(config.extensionsDir, safe);
  // basename plus this containment check: a request can never escape the dir.
  if (!dir.startsWith(path.resolve(config.extensionsDir) + path.sep) || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  log.warn('extension removed', { id: safe });
  return true;
}
