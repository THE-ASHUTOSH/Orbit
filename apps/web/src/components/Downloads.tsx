/**
 * Files the shared browser downloaded, and a way to get them onto your own
 * machine.
 *
 * Downloads land in the container (the remote browser has no access to your
 * filesystem, by design), so each row links to the authenticated endpoint that
 * streams the file back with Content-Disposition: attachment - which is what
 * makes your own browser save it locally.
 */
interface DownloadFile {
  name: string;
  size: number;
  modified: number;
}

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const when = (ms: number) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
};

export function Downloads({
  files,
  onClose,
  onDelete,
  onRefresh,
}: {
  files: DownloadFile[];
  onClose: () => void;
  onDelete: (name: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="absolute bottom-0 right-0 z-30 max-h-[70%] w-full max-w-md overflow-y-auto border-l border-t border-line bg-panel p-3 shadow-2xl">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Downloads</h2>
        <span className="flex gap-1">
          <button onClick={onRefresh} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
            refresh
          </button>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-elev">
            close
          </button>
        </span>
      </header>

      {files.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          Nothing downloaded yet. Files the remote browser downloads show up here, and you can save them to this device.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 rounded border border-line px-2 py-1.5 text-[11px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" title={f.name}>
                  {f.name}
                </span>
                <span className="text-ink-3">
                  {size(f.size)} · {when(f.modified)}
                </span>
              </span>
              {/* A normal link to an authenticated endpoint: the cookie goes with
                  it and the browser saves the file where you keep your files. */}
              <a
                href={`/api/downloads/${encodeURIComponent(f.name)}`}
                download={f.name}
                className="shrink-0 rounded bg-sky-600 px-2 py-1 font-medium text-white hover:bg-sky-500"
              >
                Save
              </a>
              <button
                onClick={() => onDelete(f.name)}
                className="shrink-0 rounded px-1.5 py-1 text-ink-3 hover:bg-elev hover:text-red-400"
                title="Delete from the server"
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
