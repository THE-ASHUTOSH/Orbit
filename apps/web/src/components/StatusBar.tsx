import type { ServerMetrics, TabInfo, UserInfo } from '@orbit/protocol';
import type { ConnectionStatus, LatencySample } from '../lib/socket';

interface Props {
  users: UserInfo[];
  tabs: TabInfo[];
  selfUserId: string;
  status: ConnectionStatus;
  latency: LatencySample;
  metrics: ServerMetrics | null;
  showMetrics: boolean;
  onToggleMetrics: () => void;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function StatusBar({ users, tabs, selfUserId, status, latency, metrics, showMetrics, onToggleMetrics }: Props) {
  return (
    <div className="flex items-center gap-3 border-t border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-400">
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${status === 'open' ? 'bg-emerald-500' : 'bg-orange-500 animate-pulse'}`} />
        {status === 'open' ? 'connected' : status}
      </span>

      <div className="flex flex-wrap items-center gap-2">
        {users.map((u) => {
          const tab = tabs.find((t) => t.tabId === u.currentTabId);
          const where = tab ? tab.label || tab.title || hostOf(tab.url) || 'new tab' : null;
          return (
            <span
              key={u.userId}
              className="flex items-center gap-1.5"
              style={{ opacity: u.state === 'idle' ? 0.55 : 1 }}
              title={`${u.username} · ${u.role} · ${u.state}${where ? ` · on ${where}` : ''}`}
            >
              {/* One dot per person, in their colour. State is shown by the ring
                  and opacity rather than a second dot. */}
              <span
                className={`size-2.5 shrink-0 rounded-full ring-1 ${
                  u.state === 'reconnecting' ? 'animate-pulse ring-orange-400' : 'ring-black/60'
                }`}
                style={{ background: u.color }}
              />
              <span className={u.userId === selfUserId ? 'font-medium text-neutral-200' : ''}>
                {u.displayName}
                {u.userId === selfUserId ? ' (you)' : ''}
              </span>
              {where && <span className="max-w-[10rem] truncate text-neutral-500">on {where}</span>}
            </span>
          );
        })}
      </div>

      <button onClick={onToggleMetrics} className="ml-auto rounded px-2 py-0.5 hover:bg-neutral-800">
        {showMetrics ? 'hide metrics' : 'metrics'}
      </button>

      {showMetrics && (
        <span className="flex items-center gap-3 font-mono">
          <span title="WebSocket round trip">rtt {latency.rttMs}ms</span>
          <span title="Client send -> server received the input event">in {latency.inputMs}ms</span>
          <span title="Server received -> dispatched into Chromium (arbiter queue)">q {latency.queueMs}ms</span>
          <span title="Client send -> first frame captured after dispatch was painted" className="text-neutral-200">
            total {latency.totalMs}ms
          </span>
          {metrics && (
            <>
              <span title="Frames per second across all streams">{metrics.framesPerSecond}fps</span>
              <span title="Stream throughput">{(metrics.bytesPerSecond / 125_000).toFixed(1)}Mbps</span>
              <span title="Container CPU">cpu {metrics.cpuPercent}%</span>
              <span title="Container memory">mem {(metrics.rssBytes / 1e9).toFixed(2)}GB</span>
            </>
          )}
        </span>
      )}
    </div>
  );
}
