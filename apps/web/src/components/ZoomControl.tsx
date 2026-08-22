/**
 * Zoom control.
 *
 * Zoom here is not a CSS transform - it changes the size of the remote viewport,
 * so the page reflows and every frame stays natively rendered. That is why this
 * shows the resulting resolution: at high zoom the page is rendered into fewer
 * pixels and then scaled up to your window, which is a real trade the user
 * should be able to see rather than discover.
 *
 * The slider commits on a short debounce because each change restarts the
 * screencast; dragging without that would restart it on every pixel.
 */
import { useEffect, useRef, useState } from 'react';

const MIN = 25;
const MAX = 400;
const PRESETS = [50, 75, 100, 125, 150, 200];

interface Props {
  zoom: number;
  canControl: boolean;
  /** Streamed resolution at the current zoom, for the readout. */
  width: number;
  height: number;
  onZoom: (zoom: number) => void;
}

export function ZoomControl({ zoom, canControl, width, height, onZoom }: Props) {
  const applied = Math.round(zoom * 100);
  const [pending, setPending] = useState(applied);
  /**
   * The text field's value, as a single source of truth.
   *
   * There is deliberately no "am I typing" flag. With one, the flag was set on
   * focus only - and since Enter does not blur, a second edit never re-entered
   * typing mode, so React kept overwriting each keystroke with the old value and
   * only the first typed zoom ever applied.
   */
  const [draft, setDraft] = useState(`${applied}%`);
  const focused = useRef(false);
  /** Set by Escape so the blur it causes does not apply the abandoned value. */
  const cancelled = useRef(false);
  const timer = useRef(0);
  const field = useRef<HTMLInputElement>(null);

  // Follow the server, unless the field is being edited right now.
  useEffect(() => {
    if (focused.current) return;
    setPending(applied);
    setDraft(`${applied}%`);
  }, [applied]);

  const commit = (value: number) => {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(value)));
    setPending(clamped);
    setDraft(`${clamped}%`);
    onZoom(clamped / 100);
  };

  /** Slider: update the label immediately, apply shortly after. */
  const glide = (value: number) => {
    setPending(value);
    setDraft(`${value}%`);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(value), 180);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /**
   * Read the value off the element rather than from state: an input event and
   * the Enter that follows can land before React has re-rendered, and the
   * handler would then commit a stale draft (or the old value).
   */
  const submitDraft = () => {
    const raw = (field.current?.value ?? draft).replace(/[^0-9]/g, '');
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) commit(n);
    else setDraft(`${applied}%`);
  };

  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-ink">Zoom</span>
        <span className="font-mono text-[10px] text-ink-3" title="Streamed resolution at this zoom">
          {width}×{height}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Step label="Zoom out" disabled={!canControl || pending <= MIN} onClick={() => commit(pending - stepFrom(pending, -1))}>
          −
        </Step>

        <form
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <input
            ref={field}
            aria-label="Zoom percentage"
            value={draft}
            disabled={!canControl}
            inputMode="numeric"
            onFocus={(e) => {
              focused.current = true;
              setDraft(String(pending));
              e.currentTarget.select();
            }}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={() => {
              focused.current = false;
              if (cancelled.current) {
                cancelled.current = false;
                setDraft(`${applied}%`);
                setPending(applied);
                return;
              }
              submitDraft();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Select the applied value so the next edit replaces it, rather
                // than appending to it.
                e.preventDefault();
                submitDraft();
                requestAnimationFrame(() => field.current?.select());
              }
              if (e.key === 'Escape') {
                // Claim the event so the surrounding menu stays open, and mark
                // the edit abandoned so the blur does not commit it.
                e.preventDefault();
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
            className="w-full rounded border border-line-2 bg-surface px-2 py-1 text-center tabular-nums outline-none focus:border-sky-500 disabled:opacity-40"
          />
        </form>

        <Step label="Zoom in" disabled={!canControl || pending >= MAX} onClick={() => commit(pending + stepFrom(pending, 1))}>
          +
        </Step>

        <button
          onClick={() => commit(100)}
          disabled={!canControl || applied === 100}
          title="Reset zoom to 100%"
          className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-elev disabled:opacity-30 disabled:hover:bg-transparent"
        >
          Reset
        </button>
      </div>

      <input
        type="range"
        min={MIN}
        max={MAX}
        step={5}
        value={pending}
        disabled={!canControl}
        aria-label="Zoom"
        aria-valuetext={`${pending} percent`}
        onChange={(e) => glide(Number(e.target.value))}
        className="mt-2 w-full accent-sky-500 disabled:opacity-40"
      />

      <div className="mt-1.5 flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => commit(p)}
            disabled={!canControl}
            className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
              applied === p ? 'bg-sky-600 text-white' : 'text-ink-2 hover:bg-elev'
            } disabled:opacity-40`}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}

/** Coarser steps at the extremes, so the buttons feel the same at 30% and 300%. */
function stepFrom(current: number, direction: 1 | -1): number {
  const magnitude = current >= 200 ? 25 : current >= 100 ? 10 : 5;
  void direction;
  return magnitude;
}

const Step = ({
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
    className="size-7 shrink-0 rounded border border-line-2 text-sm leading-none hover:bg-elev disabled:opacity-30"
  >
    {children}
  </button>
);
