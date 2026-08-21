import type { ServerMetrics, TabInfo, UserInfo } from '@orbit/protocol';
import { useTheme } from '../lib/theme';
import type { ConnectionStatus, LatencySample } from '../lib/socket';

interface Props {
  users: UserInfo[];
  tabs: TabInfo[];
  browserStatus: string;
  isAdmin: boolean;
  onToggleAdmin: () => void;
  onLogout: () => void;
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

export function StatusBar({
  users,
  tabs,
  browserStatus,
  isAdmin,
  onToggleAdmin,
  onLogout,
  selfUserId,
  status,
  latency,
  metrics,
  showMetrics,
  onToggleMetrics,
}: Props) {
  const { theme, cycle } = useTheme();
  return (
    <div className="flex items-center gap-3 border-t border-line bg-panel px-3 py-1.5 text-[11px] text-ink-2">
      {/* This is the only chrome bar, so the old top header's contents live here:
          the wordmark, connection state, who is where, metrics and the actions.
          No separate identity chip - the user list already marks you in your own
          colour, which is one less thing competing for width. */}
      <span className="flex shrink-0 items-center gap-1.5 font-semibold text-ink" title="Orbit">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <ellipse cx="6" cy="6" rx="5" ry="2.6" fill="none" stroke="#38bdf8" strokeWidth="1.1" transform="rotate(-30 6 6)" />
          {/* currentColor so the mark stays visible in both themes. */}
          <circle cx="6" cy="6" r="1.7" fill="currentColor" />
        </svg>
        Orbit
      </span>
      <span className="h-3 w-px shrink-0 bg-elev" aria-hidden="true" />

      <span className="flex shrink-0 items-center gap-1.5" title={`connection: ${status}`}>
        <span className={`size-2 rounded-full ${status === 'open' ? 'bg-emerald-500' : 'bg-orange-500 animate-pulse'}`} />
        {status === 'open' ? 'connected' : status}
      </span>

      {browserStatus !== 'running' && (
        <span className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-300">{browserStatus}</span>
      )}

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
              <span className={u.userId === selfUserId ? 'font-medium text-ink' : ''}>
                {u.displayName}
                {u.userId === selfUserId ? ' (you)' : ''}
              </span>
              {u.userId === selfUserId && (
                <span className="rounded bg-elev px-1 text-[10px] uppercase tracking-wide text-ink-2">
                  {u.role}
                </span>
              )}
              {where && <span className="max-w-[10rem] truncate text-ink-3">on {where}</span>}
            </span>
          );
        })}
      </div>

      {/* Right-hand cluster: readouts then actions, so nothing shifts when the
          metrics readout is toggled. */}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {showMetrics && (
          <span className="flex items-center gap-3 font-mono">
            <span title="WebSocket round trip">rtt {latency.rttMs}ms</span>
            <span title="Client send -> server received the input event">in {latency.inputMs}ms</span>
            <span title="Server received -> dispatched into Chromium (arbiter queue)">q {latency.queueMs}ms</span>
            <span title="Client send -> first frame captured after dispatch was painted" className="text-ink">
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
        <span className="flex items-center gap-1">
          <button
            onClick={cycle}
            className="rounded px-2 py-0.5 hover:bg-elev"
            title={`Theme: ${theme}. Click to change (system, light, dark).`}
            aria-label={`Theme: ${theme}`}
          >
            {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐'}
          </button>
          <button onClick={onToggleMetrics} className="rounded px-2 py-0.5 hover:bg-elev">
            {showMetrics ? 'hide' : 'metrics'}
          </button>
          {isAdmin && (
            <button onClick={onToggleAdmin} className="rounded border border-line-2 px-2 py-0.5 hover:bg-elev">
              admin
            </button>
          )}
          <button onClick={onLogout} className="rounded px-2 py-0.5 hover:bg-elev">
            logout
          </button>
        </span>
      </span>

    </div>
  );
}
