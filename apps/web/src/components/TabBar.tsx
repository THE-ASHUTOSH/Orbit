import type { TabInfo, UserInfo } from '@orbit/protocol';

interface Props {
  tabs: TabInfo[];
  activeTabId: string | null;
  users: UserInfo[];
  canCreate: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  onRename: (tabId: string, label: string) => void;
}

/** Tabs are keyed by their server id - never by position in this array. */
export function TabBar({ tabs, activeTabId, users, canCreate, onSelect, onClose, onCreate, onRename }: Props) {
  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-900 px-2 pt-1.5">
      {tabs.map((tab) => {
        const active = tab.tabId === activeTabId;
        const viewers = users.filter((u) => tab.viewers.includes(u.userId));
        return (
          <div
            key={tab.tabId}
            onClick={() => onSelect(tab.tabId)}
            onDoubleClick={() => {
              const label = window.prompt('Tab name', tab.label ?? tab.title ?? '');
              if (label !== null) onRename(tab.tabId, label);
            }}
            className={`group flex min-w-[9rem] max-w-[15rem] shrink-0 cursor-pointer items-center gap-2 rounded-t-md border-x border-t px-3 py-2 text-xs ${
              active
                ? 'border-neutral-700 bg-neutral-950 text-neutral-100'
                : 'border-transparent bg-neutral-800/60 text-neutral-400 hover:bg-neutral-800'
            }`}
            title={`${tab.title || tab.url}\n${tab.url}\n${tab.tabId}`}
          >
            {tab.loading ? (
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-sky-400" />
            ) : (
              <span className="size-2 shrink-0 rounded-full bg-neutral-600" />
            )}
            <span className="truncate">{tab.label || tab.title || hostOf(tab.url) || 'New tab'}</span>
            <span className="ml-auto flex items-center gap-1">
              {/* Who is on this tab, in each person's own colour. */}
              {viewers.slice(0, 4).map((u) => (
                <span
                  key={u.userId}
                  className={`size-2.5 rounded-full ring-1 ring-black/60 ${u.state === 'reconnecting' ? 'animate-pulse' : ''}`}
                  style={{ background: u.color, opacity: u.state === 'idle' ? 0.5 : 1 }}
                  title={`${u.displayName} is on this tab`}
                />
              ))}
              {viewers.length > 4 && (
                <span className="text-[10px] leading-none text-neutral-400" title={viewers.map((u) => u.displayName).join(', ')}>
                  +{viewers.length - 4}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.tabId);
                }}
                className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                aria-label="Close tab"
              >
                ×
              </button>
            </span>
          </div>
        );
      })}
      {canCreate && (
        <button
          onClick={onCreate}
          className="mb-1 ml-1 shrink-0 rounded px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          aria-label="New tab"
          title="New tab"
        >
          +
        </button>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
