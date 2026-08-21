import { useEffect, useState } from 'react';
import type { TabInfo } from '@orbit/protocol';

interface Props {
  tab: TabInfo | null;
  canControl: boolean;
  onNavigate: (url: string) => void;
  onAction: (action: 'reload' | 'back' | 'forward' | 'stop' | 'duplicate') => void;
}

export function Toolbar({ tab, canControl, onNavigate, onAction }: Props) {
  const [value, setValue] = useState(tab?.url ?? '');
  const [editing, setEditing] = useState(false);

  // Follow the tab's real URL unless the user is mid-edit; the server is the
  // authority on where the tab actually is.
  useEffect(() => {
    if (!editing) setValue(tab?.url === 'about:blank' ? '' : (tab?.url ?? ''));
  }, [tab?.url, tab?.tabId, editing]);

  const disabled = !tab || !canControl;

  return (
    <div className="flex items-center gap-1.5 border-b border-neutral-800 bg-neutral-900 px-2 py-1.5">
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

      <form
        className="flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (value.trim()) onNavigate(value.trim());
        }}
      >
        <input
          className="w-full rounded-full border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs outline-none focus:border-sky-500 disabled:opacity-60"
          value={value}
          disabled={disabled}
          placeholder={canControl ? 'Search or enter address' : 'View only'}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          spellCheck={false}
        />
      </form>

      <ToolButton label="Duplicate tab" disabled={disabled} onClick={() => onAction('duplicate')}>
        ⧉
      </ToolButton>
    </div>
  );
}

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
      className="size-7 shrink-0 rounded text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
    >
      {children}
    </button>
  );
}
