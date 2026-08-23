/**
 * The address bar, with suggestions drawn from bookmarks and history.
 *
 * Extracted from the toolbar once it needed a dropdown, keyboard selection and
 * debounced lookups - three concerns that do not belong in a row of buttons.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import { api, type Suggestion } from '../lib/api';

interface Props {
  url: string;
  disabled: boolean;
  onNavigate: (url: string) => void;
}

export const AddressBar = forwardRef<HTMLInputElement, Props>(function AddressBar({ url, disabled, onNavigate }, ref) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const timer = useRef(0);

  // Follow the tab unless the user is typing: the server is the authority on
  // where the tab actually is.
  useEffect(() => {
    if (!editing) setValue(url === 'about:blank' ? '' : url);
  }, [url, editing]);

  useEffect(() => {
    if (!editing || value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void api
        .suggest(value.trim())
        .then((r) => setSuggestions(r.suggestions))
        .catch(() => setSuggestions([]));
    }, 120);
    return () => window.clearTimeout(timer.current);
  }, [value, editing]);

  const go = (target: string) => {
    setEditing(false);
    setSuggestions([]);
    setHighlight(-1);
    if (target.trim()) onNavigate(target.trim());
  };

  return (
    <div className="relative flex-1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(highlight >= 0 && suggestions[highlight] ? suggestions[highlight]!.url : value);
        }}
      >
        <input
          ref={ref}
          className="w-full rounded-full border border-line-2 bg-surface px-3 py-1.5 text-xs outline-none focus:border-sky-500 disabled:opacity-60"
          value={value}
          disabled={disabled}
          placeholder={disabled ? 'View only' : 'Search or enter address'}
          onChange={(e) => {
            // Typing means editing. Focus alone is not enough to rely on: after
            // Enter the input keeps focus, so onFocus never fires again and a
            // second query would silently get no suggestions.
            setEditing(true);
            setValue(e.target.value);
            setHighlight(-1);
          }}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            // Deferred: a click on a suggestion must land before the list closes.
            window.setTimeout(() => {
              setEditing(false);
              setSuggestions([]);
              setHighlight(-1);
            }, 120);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setHighlight((h) => (h + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setSuggestions([]);
              setHighlight(-1);
              e.currentTarget.blur();
            }
          }}
          spellCheck={false}
          aria-label="Address and search"
          autoComplete="off"
        />
      </form>

      {editing && suggestions.length > 0 && (
        <ul className="absolute left-0 right-0 top-8 z-40 overflow-hidden rounded-md border border-line-2 bg-panel py-1 shadow-2xl">
          {suggestions.map((s, i) => (
            <li key={s.url}>
              <button
                // pointerDown, not click: blur fires first on click and the list
                // would already be gone.
                onPointerDown={(e) => {
                  e.preventDefault();
                  go(s.url);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                  i === highlight ? 'bg-elev' : ''
                }`}
              >
                <span className="w-3 shrink-0 text-[10px] text-ink-3">{s.kind === 'bookmark' ? '★' : '↻'}</span>
                <span className="min-w-0 flex-1 truncate">{s.title || s.url}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[10px] text-ink-3">{hostOf(s.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
