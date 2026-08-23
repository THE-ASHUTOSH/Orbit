/**
 * Bookmarks. Shared, like everything else about this browser: a link one person
 * saves is a link everyone has.
 */
import type { Bookmark } from '../lib/api';

export function BookmarksPanel({
  bookmarks,
  onClose,
  onOpen,
  onRemove,
}: {
  bookmarks: Bookmark[];
  onClose: () => void;
  onOpen: (url: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <aside className="absolute bottom-0 right-0 z-30 max-h-[70%] w-full max-w-md overflow-y-auto border-l border-t border-line bg-panel p-3 shadow-2xl">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Bookmarks</h2>
        <button onClick={onClose} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
          close
        </button>
      </header>

      {bookmarks.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          Nothing saved yet. Use the ★ in the toolbar to bookmark the page you are on.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {bookmarks.map((b) => (
            <li key={b.id} className="flex items-center gap-2 rounded border border-line px-2 py-1.5 text-[11px]">
              <button onClick={() => onOpen(b.url)} className="min-w-0 flex-1 text-left hover:underline">
                <span className="block truncate font-medium">{b.title || b.url}</span>
                <span className="block truncate text-ink-3">{b.url}</span>
              </button>
              <button
                onClick={() => onRemove(b.id)}
                title="Remove bookmark"
                // Without this the accessible name is the "x" glyph: text
                // content wins over title.
                aria-label={`Remove bookmark ${b.title || b.url}`}
                className="shrink-0 rounded px-1.5 py-1 text-ink-3 hover:bg-elev hover:text-red-400"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * Browsing history. The address bar is where history is normally *used* (it
 * feeds suggestions); this is for finding something you cannot quite name.
 */
export function HistoryPanel({
  entries,
  onClose,
  onOpen,
  onSearch,
  canClear,
  onClear,
}: {
  entries: { url: string; title: string; at: number; visits: number }[];
  onClose: () => void;
  onOpen: (url: string) => void;
  onSearch: (q: string) => void;
  canClear: boolean;
  onClear: () => void;
}) {
  return (
    <aside className="absolute bottom-0 right-0 z-30 max-h-[70%] w-full max-w-md overflow-y-auto border-l border-t border-line bg-panel p-3 shadow-2xl">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">History</h2>
        <span className="flex gap-1">
          {canClear && (
            <button onClick={onClear} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev hover:text-red-400">
              clear
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
            close
          </button>
        </span>
      </header>

      <input
        placeholder="Search history"
        onChange={(e) => onSearch(e.target.value)}
        className="mt-2 w-full rounded border border-line-2 bg-surface px-2 py-1 text-xs outline-none focus:border-sky-500"
      />

      <ul className="mt-2 space-y-1">
        {entries.map((h) => (
          <li key={h.url} className="rounded border border-line px-2 py-1.5 text-[11px]">
            <button onClick={() => onOpen(h.url)} className="w-full text-left hover:underline">
              <span className="block truncate font-medium">{h.title || h.url}</span>
              <span className="block truncate text-ink-3">
                {h.url} · {h.visits} visit{h.visits === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
        {entries.length === 0 && <li className="text-[11px] text-ink-3">nothing yet</li>}
      </ul>
    </aside>
  );
}
