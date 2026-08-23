/**
 * The extensions panel - the puzzle-piece list, in the place a browser puts it.
 *
 * Clicking an extension opens its page as a tab rather than a floating popup:
 * Chromium renders extension popups as native windows, outside any page's
 * compositor surface, so a popup can never appear in the stream. The page itself
 * is ordinary HTML and streams like anything else.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Installed {
  id: string;
  name: string;
  version: string;
  hasPopup: boolean;
  hasOptions: boolean;
}

export function ExtensionsPanel({
  canOpen,
  isAdmin,
  onClose,
  onManage,
  onError,
}: {
  canOpen: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onManage: () => void;
  onError: (message: string) => void;
}) {
  const [extensions, setExtensions] = useState<Installed[] | null>(null);
  const [storeId, setStoreId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    void api
      .installedExtensions()
      .then((r) => setExtensions(r.extensions))
      .catch(() => setExtensions([]));

  useEffect(load, []);

  const installFromStore = () => {
    if (!storeId.trim()) return;
    setBusy(true);
    setNote(null);
    void api
      .installFromStore(storeId)
      .then((r) => {
        setStoreId('');
        setNote(`Installed ${r.extension.name} ${r.extension.version} - restart the browser to load it.`);
        load();
      })
      .catch((err: Error) => setNote(err.message || 'That extension could not be installed.'))
      .finally(() => setBusy(false));
  };

  const open = (id: string, page: 'popup' | 'options') => {
    void api.openExtension(id, page).then(onClose).catch(() => onError('That extension has no page to open.'));
  };

  return (
    <aside className="absolute bottom-0 right-0 z-30 max-h-[70%] w-full max-w-md overflow-y-auto border-l border-t border-line bg-panel p-3 shadow-2xl">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Extensions</h2>
        <span className="flex gap-1">
          {isAdmin && (
            <button onClick={onManage} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
              manage
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
            close
          </button>
        </span>
      </header>

      {isAdmin && (
        <form
          className="mt-2 rounded border border-line px-2 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            installFromStore();
          }}
        >
          <label className="block text-[11px] font-medium">Add from the Chrome Web Store</label>
          <div className="mt-1 flex gap-1">
            <input
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              placeholder="Store URL or extension id"
              aria-label="Chrome Web Store URL or extension id"
              className="min-w-0 flex-1 rounded border border-line-2 bg-surface px-2 py-1 text-[11px] outline-none focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={busy || !storeId.trim()}
              className="shrink-0 rounded bg-sky-600 px-2 py-1 text-[11px] text-white disabled:opacity-40"
            >
              {busy ? 'Installing…' : 'Install'}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-ink-3">
            Downloaded and unpacked, not verified - it runs in the shared browser with the permissions its manifest asks
            for. A browser restart loads it.
          </p>
          {note && <p className="mt-1 text-[10px] text-ink-2">{note}</p>}
        </form>
      )}

      {extensions === null ? (
        <p className="mt-3 text-xs text-ink-3">Loading…</p>
      ) : extensions.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          None installed.{isAdmin ? ' Upload one as a .zip from the admin panel.' : ' An admin can install one.'}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {extensions.map((e) => (
            <li key={e.id} className="flex items-center gap-2 rounded border border-line px-2 py-1.5 text-[11px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{e.name}</span>
                <span className="block truncate text-ink-3">v{e.version}</span>
              </span>
              {e.hasPopup && (
                <button
                  onClick={() => open(e.id, 'popup')}
                  disabled={!canOpen}
                  className="shrink-0 rounded bg-elev px-2 py-1 hover:bg-elev-2 disabled:opacity-40"
                >
                  Open
                </button>
              )}
              {e.hasOptions && (
                <button
                  onClick={() => open(e.id, 'options')}
                  disabled={!canOpen}
                  className="shrink-0 rounded px-2 py-1 text-ink-2 hover:bg-elev disabled:opacity-40"
                >
                  Options
                </button>
              )}
              {!e.hasPopup && !e.hasOptions && <span className="shrink-0 text-ink-3">no page</span>}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
