/**
 * Right-click menu for the streamed page.
 *
 * Chromium's own context menu is a native popup: it is not part of the page's
 * compositor surface, so it can never appear in the stream. This is the
 * replacement, built from what the server reports is under the pointer.
 */
import { useEffect, useRef } from 'react';

export interface ContextTarget {
  x: number;
  y: number;
  link: string | null;
  image: string | null;
  selection: string;
}

interface Props {
  target: ContextTarget;
  canControl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onClose: () => void;
  onAction: (action: 'back' | 'forward' | 'reload') => void;
  onOpenLink: (url: string) => void;
  onCopyText: (text: string) => void;
  onPageCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

export function ContextMenu({
  target,
  canControl,
  canGoBack,
  canGoForward,
  onClose,
  onAction,
  onOpenLink,
  onCopyText,
  onPageCopy,
  onPaste,
  onSelectAll,
}: Props) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // Keep the menu inside the window.
  const style = {
    left: Math.min(target.x, window.innerWidth - 210),
    top: Math.min(target.y, window.innerHeight - 260),
  };

  return (
    <div
      ref={box}
      role="menu"
      style={style}
      className="fixed z-50 w-52 overflow-hidden rounded-md border border-line-2 bg-panel py-1 text-xs shadow-2xl"
    >
      {target.link && (
        <>
          <Row onClick={act(() => onOpenLink(target.link!))}>Open link in new tab</Row>
          <Row onClick={act(() => onCopyText(target.link!))}>Copy link address</Row>
          <Line />
        </>
      )}
      {target.image && (
        <>
          <Row onClick={act(() => onOpenLink(target.image!))}>Open image in new tab</Row>
          <Row onClick={act(() => onCopyText(target.image!))}>Copy image address</Row>
          <Line />
        </>
      )}
      <Row onClick={act(() => onAction('back'))} disabled={!canControl || !canGoBack}>
        Back
      </Row>
      <Row onClick={act(() => onAction('forward'))} disabled={!canControl || !canGoForward}>
        Forward
      </Row>
      <Row onClick={act(() => onAction('reload'))} disabled={!canControl}>
        Reload
      </Row>
      <Line />
      <Row onClick={act(onPageCopy)} disabled={!canControl || !target.selection}>
        Copy
      </Row>
      <Row onClick={act(onPaste)} disabled={!canControl}>
        Paste
      </Row>
      <Row onClick={act(onSelectAll)} disabled={!canControl}>
        Select all
      </Row>
    </div>
  );
}

const Row = ({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="block w-full px-3 py-1.5 text-left hover:bg-elev disabled:opacity-40 disabled:hover:bg-transparent"
  >
    {children}
  </button>
);

const Line = () => <div className="my-1 h-px bg-line" />;
