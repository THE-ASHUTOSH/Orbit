/**
 * The ⋮ menu, in the place and shape a browser puts it.
 *
 * Everything that is an *action* lives here - zoom, downloads, extensions,
 * DevTools, theme, session - which leaves the toolbar for navigation and the
 * bottom bar for status. Before this, both bars were competing for width with
 * buttons that are used occasionally.
 */
import { useEffect, useRef, useState } from 'react';
import type { ThemeChoice } from '../lib/theme';
import { ZoomControl } from './ZoomControl';
import { altChord } from '../lib/platform';

interface Props {
  zoom: number;
  /** Streamed resolution, shown by the zoom control. */
  viewWidth: number;
  viewHeight: number;
  canControl: boolean;
  onZoom: (zoom: number) => void;
  downloadCount: number;
  onOpenDownloads: () => void;
  canInspect: boolean;
  onInspect: () => void;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  theme: ThemeChoice;
  onCycleTheme: () => void;
  showMetrics: boolean;
  onToggleMetrics: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  captured: boolean;
  captureMode: 'locked' | 'partial' | null;
  onToggleCapture: () => void;
  bookmarkCount: number;
  onOpenBookmarks: () => void;
  onOpenHistory: () => void;
  onOpenExtensions: () => void;
  onNewTab: () => void;
  onDuplicateTab: () => void;
  onLogout: () => void;
}

export function Menu({
  zoom,
  viewWidth,
  viewHeight,
  canControl,
  onZoom,
  downloadCount,
  onOpenDownloads,
  canInspect,
  onInspect,
  isAdmin,
  onOpenAdmin,
  theme,
  onCycleTheme,
  showMetrics,
  onToggleMetrics,
  fullscreen,
  onToggleFullscreen,
  captured,
  captureMode,
  onToggleCapture,
  bookmarkCount,
  onOpenBookmarks,
  onOpenHistory,
  onOpenExtensions,
  onNewTab,
  onDuplicateTab,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape, the way every other menu behaves.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Bubble phase, and skip anything already handled: Escape inside the zoom
      // field should revert that field, not tear down the whole menu. Capture
      // phase here would fire first and always win.
      if (e.key === 'Escape' && !e.defaultPrevented) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Menu"
        aria-label="Menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className="size-7 rounded text-base leading-none text-ink-2 hover:bg-elev"
      >
        ⋮
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-40 w-64 overflow-hidden rounded-md border border-line-2 bg-panel py-1 text-xs shadow-2xl"
        >
          <ZoomControl zoom={zoom} canControl={canControl} width={viewWidth} height={viewHeight} onZoom={onZoom} />

          <Divider />
          <Item onClick={run(onNewTab)}>New tab</Item>
          <Item onClick={run(onDuplicateTab)} disabled={!canControl}>
            Duplicate tab
          </Item>

          <Divider />
          {/* Neither of these uses `run`: both need the click itself as their
              user gesture (fullscreen may only be requested from one), and
              closing the menu first would take the focus with it. */}
          <Item
            onClick={() => {
              setOpen(false);
              onToggleFullscreen();
            }}
            hint={fullscreen ? 'on' : 'off'}
          >
            Full screen · {altChord('F')}
          </Item>
          <Item
            onClick={() => {
              setOpen(false);
              onToggleCapture();
            }}
            hint={captured ? (captureMode === 'locked' ? 'on' : 'partial') : 'off'}
          >
            Capture keyboard · {altChord('K')}
          </Item>

          <Divider />
          <Item onClick={run(onOpenBookmarks)} hint={bookmarkCount > 0 ? String(bookmarkCount) : undefined}>
            Bookmarks
          </Item>
          <Item onClick={run(onOpenHistory)}>History</Item>
          <Item onClick={run(onOpenDownloads)} hint={downloadCount > 0 ? String(downloadCount) : undefined}>
            Downloads
          </Item>
          <Item onClick={run(onOpenExtensions)}>Extensions</Item>
          {canInspect && <Item onClick={run(onInspect)}>Inspect (DevTools)</Item>}

          <Divider />
          <Item onClick={onCycleTheme} hint={theme}>
            Appearance
          </Item>
          <Item onClick={onToggleMetrics} hint={showMetrics ? 'on' : 'off'}>
            Performance metrics
          </Item>
          {isAdmin && <Item onClick={run(onOpenAdmin)}>Admin panel</Item>}

          <Divider />
          <Item onClick={run(onLogout)}>Sign out</Item>
        </div>
      )}
    </div>
  );
}

function Item({
  children,
  onClick,
  disabled,
  hint,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-elev disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span>{children}</span>
      {hint && <span className="ml-3 shrink-0 text-[10px] uppercase tracking-wide text-ink-3">{hint}</span>}
    </button>
  );
}

const MenuIconButton = ({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    className="size-6 rounded hover:bg-elev disabled:opacity-40"
  >
    {children}
  </button>
);

const Divider = () => <div className="my-1 h-px bg-line" />;
