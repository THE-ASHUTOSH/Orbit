/**
 * Chromium extensions, loaded unpacked from a directory on the data volume.
 *
 * Unpacked is the only sane option here. One-click Web Store installs would mean
 * fetching signed .crx packages from Google's update service and unpacking crx3
 * ourselves, which is fragile and not what that service is for. Almost every
 * extension worth running in a shared browser also publishes a plain zip, and a
 * zip is something an admin can upload and audit.
 *
 * Extensions are process-wide: Chromium takes --load-extension at launch, so a
 * change needs a browser restart. That is deliberate rather than hidden - the
 * API reports it and the admin decides when to restart.
 */
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
}

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
      };
      out.push({
        id,
        loadPath,
        name: typeof manifest.name === 'string' ? manifest.name : id,
        version: typeof manifest.version === 'string' ? manifest.version : '?',
        manifestVersion: Number(manifest.manifest_version ?? 0),
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions.slice(0, 40).map(String) : [],
        sizeBytes: directorySize(root),
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
