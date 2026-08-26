import { forwardRef } from 'react';
import type { TabInfo } from '@orbit/protocol';
import { AddressBar } from './AddressBar';

interface Props {
  tab: TabInfo | null;
  canControl: boolean;
  /** The ⋮ menu, rendered at the end of the bar. */
  menu: React.ReactNode;
  onResetZoom: () => void;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  /** Set when this tab belongs to someone else and control could be asked for. */
  ownerName: string | null;
  requestPending: boolean;
  onRequestControl: () => void;
  onNavigate: (url: string) => void;
  onAction: (action: 'reload' | 'back' | 'forward' | 'stop' | 'duplicate') => void;
}

export const Toolbar = forwardRef<HTMLInputElement, Props>(function Toolbar(
  {
    tab,
    canControl,
    menu,
    onResetZoom,
    bookmarked,
    onToggleBookmark,
    ownerName,
    requestPending,
    onRequestControl,
    onNavigate,
    onAction,
  },
  addressRef,
) {
  const disabled = !tab || !canControl;

  return (
    <div className="flex items-center gap-1.5 border-b border-line bg-panel px-2 py-1.5">
      <ToolButton label="Back" disabled={disabled || !tab?.canGoBack} onClick={() => onAction('back')}>
        ←
      </ToolButton>
      <ToolButton label="Forward" disabled={disabled || !tab?.canGoForward} onClick={() => onAction('forward')}>
        →
      </ToolButton>
      <ToolButton
        label={tab?.loading ? 'Stop' : 'Reload'}
        disabled={disabled}
        onClick={() => onAction(tab?.loading ? 'stop' : 'reload')}
      >
        {tab?.loading ? '×' : '⟳'}
      </ToolButton>

      <AddressBar ref={addressRef} url={tab?.url ?? ''} disabled={disabled} onNavigate={onNavigate} />

      {/* Someone else's tab: say whose, and offer to ask them. */}
      {ownerName && (
        <button
          onClick={onRequestControl}
          disabled={requestPending}
          title={`${ownerName} owns this tab - ask for control of it`}
          // Stable name, changing text: the label is what this button *is*, and
          // "waiting for an answer" is a state of it, not a different control.
          aria-label={`Ask ${ownerName} for control`}
          className="shrink-0 rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 hover:bg-elev disabled:opacity-50"
        >
          {requestPending ? `Asked ${ownerName}…` : `Ask ${ownerName} for control`}
        </button>
      )}

      <button
        onClick={onToggleBookmark}
        disabled={!tab}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
        aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
        className={`size-7 shrink-0 rounded text-sm hover:bg-elev disabled:opacity-30 ${
          bookmarked ? 'text-amber-400' : 'text-ink-2'
        }`}
      >
        {bookmarked ? '★' : '☆'}
      </button>

      {/* Only present when zoom is not 100%, the way a browser surfaces it -
          and clicking it puts you back to 100%. */}
      {tab && Math.round((tab.zoom ?? 1) * 100) !== 100 && (
        <button
          onClick={onResetZoom}
          disabled={!canControl}
          title={`Zoom ${Math.round((tab.zoom ?? 1) * 100)}% - click to reset to 100%`}
          className="shrink-0 rounded border border-line-2 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-2 hover:bg-elev disabled:opacity-40"
        >
          {Math.round((tab.zoom ?? 1) * 100)}%
        </button>
      )}

      {menu}
    </div>
  );
});

function ToolButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="size-7 shrink-0 rounded text-sm text-ink-2 hover:bg-elev disabled:opacity-30"
    >
      {children}
    </button>
  );
}
