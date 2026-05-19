import type { ConfigResponse } from '../types';

export type AppView = 'new-test' | 'test-runs' | 'inbox' | 'demo';

export function Sidebar({
  config,
  onConnectGmail,
  view,
  onView,
  runsCount,
  inboxUnread,
}: {
  config: ConfigResponse | null;
  onConnectGmail: () => void;
  view: AppView;
  onView: (v: AppView) => void;
  runsCount: number;
  inboxUnread: number;
}) {
  const gmailConnected = !!config?.gmailConnected;
  const gmailEmail = config?.gmailEmail || (config?.mode === 'demo' ? 'sfmctest950@gmail.com (demo)' : 'not connected');
  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-mark">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="0.75" y="2.75" width="14.5" height="10.5" rx="2" stroke="#15171C" strokeWidth="1.4" />
            <path d="M1.5 4.5L8 8.6 14.5 4.5" stroke="#15171C" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="13" cy="12" r="2.2" fill="#15171C" />
          </svg>
        </div>
        <div className="brand-name">
          InboxFlow<span>Agent</span>
        </div>
      </div>

      <div className="nav-group">
        <div className="nav-label">Workspace</div>
        <button
          className={`nav-item ${view === 'new-test' ? 'active' : ''}`}
          onClick={() => onView('new-test')}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          New Test
        </button>
        <button
          className={`nav-item ${view === 'test-runs' ? 'active' : ''}`}
          onClick={() => onView('test-runs')}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2" width="13" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <rect x="1.5" y="6.5" width="13" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
            <rect x="1.5" y="11" width="13" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Test Runs <span className="count">{runsCount}</span>
        </button>
        <button
          className={`nav-item ${view === 'inbox' ? 'active' : ''}`}
          onClick={() => onView('inbox')}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="3" width="13" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
            <path d="M2 4.5L8 8.5 14 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          Inbox{inboxUnread > 0 ? <span className="count count-strong">({inboxUnread})</span> : null}
        </button>
        <button
          className={`nav-item ${view === 'demo' ? 'active' : ''}`}
          onClick={() => onView('demo')}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <polygon points="4,3 12,8 4,13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
          </svg>
          Demo
        </button>
      </div>

      <div className="rail-foot">
        <div className="gmail-card">
          <div className={`gmail-dot ${gmailConnected ? '' : 'off'}`}></div>
          <div className="gmail-meta">
            <div className="lbl">
              {gmailConnected
                ? 'Gmail connected'
                : config?.gmailNeedsReauth
                  ? 'Reconnect needed'
                  : config?.mode === 'demo'
                    ? 'Demo mode'
                    : 'Gmail not connected'}
            </div>
            <div className="addr">{gmailEmail}</div>
          </div>
          {!gmailConnected && config?.gmailConfigured && (
            <button className="gmail-connect" onClick={onConnectGmail}>
              {config?.gmailNeedsReauth ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
