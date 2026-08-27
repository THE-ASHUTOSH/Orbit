/**
 * The live browser surface.
 *
 * Rendering: JPEG frames arrive as binary WebSocket messages, are decoded off
 * the main thread with createImageBitmap and painted to a canvas. Only the
 * newest frame is ever decoded - if decoding falls behind, intermediate frames
 * are dropped rather than queued, because a late frame is worse than a missing
 * one for interaction.
 *
 * Input: a transparent textarea sits over the canvas. It is what gives us IME
 * composition, mobile keyboards and paste for free; every event it receives is
 * translated to remote-viewport coordinates and forwarded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  modifiersFrom,
  remoteModifiers,
  shortcutForKey,
  nextZoom,
  type Cursor,
  type TabInfo,
} from '@orbit/protocol';
import type { BrowserSocket } from '../lib/socket';
import { IS_APPLE as APPLE, altChord } from '../lib/platform';

interface Props {
  socket: BrowserSocket;
  tab: TabInfo;
  canControl: boolean;
  cursors: Cursor[];
  selfUserId: string;
  onZoom: (zoom: number) => void;
  /** Returns true when the shortcut was handled locally and must not be forwarded. */
  onShortcut: (action: string) => boolean;
  /** Non-null while this tab holds the keyboard; 'partial' when only some of it. */
  captured: 'locked' | 'partial' | null;
  onReleaseCapture: () => void;
  /** Page coordinates for the probe, screen coordinates for placement. */
  onContextMenu: (pageX: number, pageY: number, screenX: number, screenY: number) => void;
}

/** Keys we keep for the local browser instead of forwarding. */
const LOCAL_KEYS = new Set(['F12']);
const isDevtools = (e: React.KeyboardEvent) =>
  LOCAL_KEYS.has(e.key) || (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase()));

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function Viewport({
  socket,
  tab,
  canControl,
  cursors,
  selfUserId,
  onZoom,
  onShortcut,
  captured,
  onReleaseCapture,
  onContextMenu,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Screen CSS pixels per page CSS pixel - what pointer maths needs. */
  const [scale, setScale] = useState(1);
  /** Frame dimensions in DEVICE pixels (may exceed the page's CSS size). */
  const [frameSize, setFrameSize] = useState({ width: tab.width, height: tab.height });
  /** Device pixels per CSS pixel, as reported by the server. */
  const [density, setDensity] = useState(1);
  const densityRef = useRef(1);
  const [hasFrame, setHasFrame] = useState(false);
  /** Size of the area the frame must fit inside. */
  const [stage, setStage] = useState({ w: 0, h: 0 });

  // Frame pump: one decode in flight, newest frame wins.
  const pending = useRef<Uint8Array | null>(null);
  const decoding = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    const pump = async () => {
      if (decoding.current) return;
      const data = pending.current;
      if (!data) return;
      pending.current = null;
      decoding.current = true;
      try {
        // Copy into a fresh buffer: the view points at the socket frame, which
        // must not be retained across the async decode.
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          setFrameSize({ width: bitmap.width, height: bitmap.height });
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
      } catch {
        /* a truncated frame is not worth reporting */
      } finally {
        decoding.current = false;
        if (pending.current) void pump();
      }
    };

    return socket.onFrames(tab.tabId, (header, image) => {
      // Only re-render when the density actually changes; this fires per frame.
      const d = header.scale && header.scale > 0 ? header.scale : 1;
      if (d !== densityRef.current) {
        densityRef.current = d;
        setDensity(d);
      }
      pending.current = image;
      void pump();
    });
  }, [socket, tab.tabId]);

  // Measure the stage so the canvas can be capped in pixels.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Fit the frame to the stage, preserving aspect: scale up when the frame is
   * smaller than the stage (which is what zooming in produces) and down when it
   * is larger. Computed rather than left to object-fit, because object-fit
   * letterboxes inside the element and pointer coordinates would then no longer
   * line up with the drawn image.
   */
  const display = useMemo(() => {
    const pageW = frameSize.width / density;
    const pageH = frameSize.height / density;
    if (!stage.w || !stage.h || !pageW || !pageH) return { w: 0, h: 0, scale: 1 };
    const fit = Math.min(stage.w / pageW, stage.h / pageH);
    return { w: Math.round(pageW * fit), h: Math.round(pageH * fit), scale: fit };
  }, [frameSize.width, frameSize.height, density, stage.w, stage.h]);

  useEffect(() => setScale(display.scale), [display.scale]);

  const toRemote = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || scale === 0) return { x: 0, y: 0 };
      return {
        x: Math.round((clientX - rect.left) / scale),
        y: Math.round((clientY - rect.top) / scale),
      };
    },
    [scale],
  );

  // Cursor telemetry and mousemove are coalesced to one send per frame: at 30fps
  // that is 30 messages/s instead of the ~200 a trackpad can generate.
  const moveQueue = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null);
  const rafRef = useRef(0);
  const flushMove = useCallback(() => {
    rafRef.current = 0;
    const m = moveQueue.current;
    if (!m) return;
    moveQueue.current = null;
    if (canControl) {
      socket.sendInput({
        type: 'input.mouse',
        event: 'mousemove',
        tabId: tab.tabId,
        x: m.x,
        y: m.y,
        buttons: m.buttons,
        modifiers: m.modifiers,
        button: m.buttons ? 'left' : 'none',
      });
    }
    socket.send({ type: 'cursor', tabId: tab.tabId, x: m.x, y: m.y, active: true });
  }, [canControl, socket, tab.tabId]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return; // handled by touch events
    const { x, y } = toRemote(e.clientX, e.clientY);
    moveQueue.current = { x, y, buttons: e.buttons, modifiers: remoteModifiers(e, APPLE) };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushMove);
  };

  const mouseButton = (button: number) =>
    button === 1 ? 'middle' : button === 2 ? 'right' : button === 3 ? 'back' : button === 4 ? 'forward' : 'left';

  /**
   * Keyboard focus follows the tab: after a keyboard tab switch or Alt+T,
   * typing must reach the new page without clicking it first. Skipped while a
   * form field has focus, so editing the address bar is never interrupted.
   */
  useEffect(() => {
    if (document.activeElement instanceof HTMLInputElement) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [tab.tabId]);

  const onPointerDown = (e: React.PointerEvent) => {
    inputRef.current?.focus({ preventScroll: true });
    if (!canControl || e.pointerType === 'touch') return;
    const { x, y } = toRemote(e.clientX, e.clientY);
    socket.sendInput({
      type: 'input.mouse',
      event: 'mousedown',
      tabId: tab.tabId,
      x,
      y,
      button: mouseButton(e.button),
      buttons: e.buttons,
      clickCount: (e.nativeEvent as MouseEvent).detail || 1,
      // Cmd+click on a Mac is "open in a new tab", which the remote Linux
      // browser spells Ctrl+click.
      modifiers: remoteModifiers(e, APPLE),
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!canControl || e.pointerType === 'touch') return;
    const { x, y } = toRemote(e.clientX, e.clientY);
    socket.sendInput({
      type: 'input.mouse',
      event: 'mouseup',
      tabId: tab.tabId,
      x,
      y,
      button: mouseButton(e.button),
      buttons: e.buttons,
      clickCount: (e.nativeEvent as MouseEvent).detail || 1,
      // Cmd+click on a Mac is "open in a new tab", which the remote Linux
      // browser spells Ctrl+click.
      modifiers: remoteModifiers(e, APPLE),
    });
  };

  // Wheel must be a non-passive native listener or preventDefault is ignored and
  // the page behind the viewport scrolls instead of the remote page.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!canControl) return;
      const { x, y } = toRemote(e.clientX, e.clientY);
      // DOM_DELTA_LINE/PAGE come from some mice; normalise to pixels.
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? frameSize.height / density : 1;
      socket.sendInput({
        type: 'input.mouse',
        event: 'wheel',
        tabId: tab.tabId,
        x,
        y,
        deltaX: e.deltaX * factor,
        deltaY: e.deltaY * factor,
        modifiers: modifiersFrom(e),
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canControl, frameSize.height, density, socket, tab.tabId, toRemote]);

  const composing = useRef(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isDevtools(e)) return; // let the local browser have it

    /**
     * Orbit's own shortcuts use Alt/Option, not Ctrl/Cmd.
     *
     * Ctrl+T, Ctrl+W, Ctrl+L and friends are reserved by the browser Orbit is
     * running in and cannot be intercepted from a page - mapping them would, at
     * best, do nothing and, in the case of Ctrl+W, close the user's real tab.
     * shortcutForKey matches on the physical key, so Option+T on a Mac (which
     * produces "†") still means "new tab".
     */
    const shortcut = shortcutForKey(e);
    if (shortcut && onShortcut(shortcut)) {
      e.preventDefault();
      return;
    }

    /** Ctrl on Windows and Linux, Command on a Mac: the accelerator key. */
    const accel = e.ctrlKey || (APPLE && e.metaKey);

    if ((e.key === 'F5' || (accel && e.code === 'KeyR')) && onShortcut('reload')) {
      e.preventDefault();
      return;
    }
    if (accel && ['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(e.code)) {
      e.preventDefault();
      const out = e.code === 'Minus' || e.code === 'NumpadSubtract';
      const reset = e.code === 'Digit0' || e.code === 'Numpad0';
      if (canControl) onZoom(reset ? 1 : nextZoom(tab.zoom ?? 1, out ? -1 : 1));
      return;
    }

    /**
     * Paste is deliberately NOT cancelled or forwarded here.
     *
     * Letting the key through means this browser fires its own `paste` event on
     * the textarea below, which already forwards the text as `input.text` - and
     * that needs no clipboard permission and no prompt. It is also the only path
     * that pastes what the *user* copied: Ctrl+V inside the remote browser would
     * paste the container's clipboard instead.
     *
     * This is what was broken: the blanket preventDefault further down cancelled
     * the default paste action, so the paste event never fired.
     */
    if (accel && e.code === 'KeyV' && !e.altKey) return;
    if (composing.current || e.nativeEvent.isComposing) return; // IME will commit via compositionend
    e.preventDefault();
    if (!canControl) return;
    socket.sendInput({
      type: 'input.keyboard',
      event: 'keydown',
      tabId: tab.tabId,
      key: e.key,
      code: e.code,
      location: e.location,
      repeat: e.repeat,
      modifiers: remoteModifiers(e, APPLE),
    });
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isDevtools(e) || composing.current) return;
    e.preventDefault();
    if (!canControl) return;
    socket.sendInput({
      type: 'input.keyboard',
      event: 'keyup',
      tabId: tab.tabId,
      key: e.key,
      code: e.code,
      location: e.location,
      repeat: false,
      modifiers: remoteModifiers(e, APPLE),
    });
  };

  const sendText = (text: string) => {
    if (!text || !canControl) return;
    socket.sendInput({ type: 'input.text', tabId: tab.tabId, text });
  };

  const onTouch = (event: 'touchstart' | 'touchmove' | 'touchend', e: React.TouchEvent) => {
    if (!canControl) return;
    e.preventDefault();
    const list = event === 'touchend' ? [] : Array.from(e.touches);
    socket.sendInput({
      type: 'input.touch',
      event,
      tabId: tab.tabId,
      touches: list.map((t, i) => {
        const p = toRemote(t.clientX, t.clientY);
        return { id: t.identifier ?? i, x: p.x, y: p.y };
      }),
      modifiers: 0,
    });
  };

  const overlayCursors = useMemo(() => cursors.filter((c) => c.userId !== selfUserId), [cursors, selfUserId]);

  return (
    <div ref={wrapRef} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-stage">
      <div className="relative" style={{ maxWidth: '100%', maxHeight: '100%' }}>
        <canvas
          ref={canvasRef}
          width={frameSize.width}
          height={frameSize.height}
          // Sized by the stage it sits in, not by a hardcoded viewport maths.
          className="viewport-surface block"
          // Explicit fitted size: the element is exactly the drawn image, so
          // clicks and cursor overlays share one coordinate space.
          style={display.w ? { width: display.w, height: display.h } : { maxWidth: '100%', maxHeight: '100%' }}
        />

        {/* Transparent input catcher: keyboard, IME, paste, pointer, touch. */}
        <textarea
          ref={inputRef}
          className="viewport-surface absolute inset-0 h-full w-full resize-none border-0 bg-transparent p-0 opacity-0 outline-none"
          style={{ cursor: canControl ? 'default' : 'not-allowed', caretColor: 'transparent' }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={`Remote browser viewport: ${tab.label || tab.title || hostOf(tab.url) || 'new tab'}`}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerLeave={() => socket.send({ type: 'cursor', tabId: tab.tabId, x: -1, y: -1, active: false })}
          onContextMenu={(e) => {
            e.preventDefault();
            const p = toRemote(e.clientX, e.clientY);
            onContextMenu(p.x, p.y, e.clientX, e.clientY);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            sendText(e.data);
            e.currentTarget.value = '';
          }}
          onPaste={(e) => {
            e.preventDefault();
            sendText(e.clipboardData.getData('text/plain'));
          }}
          onTouchStart={(e) => onTouch('touchstart', e)}
          onTouchMove={(e) => onTouch('touchmove', e)}
          onTouchEnd={(e) => onTouch('touchend', e)}
          onChange={(e) => {
            // Autocorrect/voice input can insert text without key events.
            const value = e.currentTarget.value;
            if (value) {
              sendText(value);
              e.currentTarget.value = '';
            }
          }}
        />

        {/* Loading, where the eye already is: a thin strip across the top of the
            page itself. Indeterminate on purpose - Chromium does not tell us how
            much of a page is left, and a bar that pretends to know is a lie. */}
        {tab.loading && (
          <div
            role="progressbar"
            aria-label="Page loading"
            aria-busy="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden bg-sky-400/20"
          >
            <div className="h-full w-1/3 animate-[orbit-loading_1.1s_ease-in-out_infinite] bg-sky-400" />
          </div>
        )}

        {/* While the keyboard is captured, say so and offer the way out - the
            usual one (this browser's own chords) is exactly what is unavailable. */}
        {captured && (
          <button
            onClick={onReleaseCapture}
            title={`Release the keyboard (${altChord('K')})`}
            className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-line-2 bg-panel/90 px-3 py-1 text-[11px] text-ink-2 shadow-lg backdrop-blur hover:bg-elev"
          >
            ⌨ Keyboard captured{captured === 'partial' ? ' (partly)' : ''} · {altChord('K')} to release
          </button>
        )}

        {/* Other users' cursors, drawn client-side over the frame. */}
        {overlayCursors.map((c) => (
          <div
            key={c.userId}
            className="pointer-events-none absolute z-10 transition-transform duration-75"
            style={{ transform: `translate(${c.x * scale}px, ${c.y * scale}px)`, opacity: c.active ? 1 : 0.35 }}
          >
            <svg width="18" height="24" viewBox="0 0 18 24" className="drop-shadow">
              <path d="M2 1 L2 18 L6.5 13.5 L9.5 21 L12.5 19.5 L9.5 12.5 L15 12.5 Z" fill={c.color} stroke="black" strokeWidth="1.2" />
            </svg>
            <span
              className="ml-3 -mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-black shadow"
              style={{ background: c.color }}
            >
              {c.displayName}
            </span>
          </div>
        ))}

        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center bg-panel/90 text-sm text-ink-2">
            <span className="animate-pulse">Waiting for the first frame…</span>
          </div>
        )}
        {!canControl && hasFrame && (
          <div className="pointer-events-none absolute right-3 top-3 rounded bg-amber-500/90 px-2 py-1 text-[11px] font-semibold text-black">
            VIEW ONLY
          </div>
        )}
      </div>
    </div>
  );
}
