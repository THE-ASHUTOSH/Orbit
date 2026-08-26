/**
 * "Can I drive this tab?" - as the owner sees it.
 *
 * A tab belongs to whoever opened it, so everyone else watches until the owner
 * says otherwise. The prompt is deliberately in the way: it is a person waiting
 * for an answer, not a notification to be collected later.
 */
import type { TabInfo } from '@orbit/protocol';

export interface AccessRequest {
  tabId: string;
  userId: string;
  displayName: string;
  at: number;
}

export function AccessRequests({
  requests,
  tabs,
  onRespond,
  onSelectTab,
}: {
  requests: AccessRequest[];
  tabs: TabInfo[];
  onRespond: (request: AccessRequest, grant: boolean) => void;
  onSelectTab: (tabId: string) => void;
}) {
  if (requests.length === 0) return null;

  const nameOf = (tabId: string) => {
    const tab = tabs.find((t) => t.tabId === tabId);
    return tab?.label || tab?.title || hostOf(tab?.url ?? '') || 'a tab';
  };

  return (
    <div className="absolute bottom-4 right-4 z-40 w-full max-w-sm space-y-2">
      {requests.map((r) => (
        <div
          key={`${r.tabId}:${r.userId}`}
          className="rounded-lg border border-line-2 bg-panel p-3 shadow-2xl"
          role="alertdialog"
          aria-label={`${r.displayName} is asking for control`}
        >
          <p className="text-xs">
            <span className="font-semibold">{r.displayName}</span> is asking for control of{' '}
            <button onClick={() => onSelectTab(r.tabId)} className="underline decoration-dotted hover:text-ink">
              {nameOf(r.tabId)}
            </button>
            .
          </p>
          <p className="mt-1 text-[10px] text-ink-3">
            They can already see this tab. Control lets them type and click in it too.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => onRespond(r, true)}
              className="rounded bg-sky-600 px-2.5 py-1 text-[11px] text-white hover:bg-sky-500"
            >
              Give control
            </button>
            <button
              onClick={() => onRespond(r, false)}
              className="rounded bg-elev px-2.5 py-1 text-[11px] hover:bg-elev-2"
            >
              Keep it to myself
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
