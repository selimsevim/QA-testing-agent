import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar, type AppView } from './components/Sidebar';
import { Activity } from './components/Activity';
import { ReportModal } from './components/ReportModal';
import { TestRunsList } from './components/TestRunsList';
import { InboxView } from './components/InboxView';
import { api } from './api';
import type { ConfigResponse, ExpectedFlow, PersonaConfig, PersonaStatus, TestRun, TestRunReport } from './types';

const DEFAULT_FLOW_TEXT =
  'After a user submits the signup form they receive a confirmation email. If they click the "Confirm subscription" CTA within 1 minute, send them a welcome email. If they do not click, send a reminder. Both paths then receive a thank-you email.';

function personaStatusText(s: PersonaStatus): { label: string; cls: 'pass' | 'fail' | 'wait' } {
  switch (s) {
    case 'waiting':
      return { label: 'Waiting', cls: 'wait' };
    case 'watching':
      return { label: 'Watching', cls: 'wait' };
    case 'email_received':
      return { label: 'Email received', cls: 'wait' };
    case 'cta_clicked':
      return { label: 'CTA clicked', cls: 'pass' };
    case 'no_interaction':
      return { label: 'No interaction', cls: 'wait' };
    case 'passed':
      return { label: 'Passed', cls: 'pass' };
    case 'failed':
      return { label: 'Failed', cls: 'fail' };
    case 'branch_error':
      return { label: 'Branch error', cls: 'fail' };
  }
}

export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [flowText, setFlowText] = useState(DEFAULT_FLOW_TEXT);
  const [parsedFlow, setParsedFlow] = useState<ExpectedFlow | null>(null);

  const [run, setRun] = useState<TestRun | null>(null);
  const [report, setReport] = useState<TestRunReport | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AppView>('new-test');
  const [runsCount, setRunsCount] = useState<number>(0);
  const [runsRefreshKey, setRunsRefreshKey] = useState<number>(0);
  const [inboxUnread, setInboxUnread] = useState<number>(0);

  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(console.error);
  }, []);

  // On first mount, look for a previously-active run id in localStorage. If the
  // server still has it (and it's still running or just finished), restore it so
  // the user picks up where they left off after a refresh.
  useEffect(() => {
    const stored = localStorage.getItem('inboxflow.activeRunId');
    if (!stored) return;
    api
      .getRun(stored)
      .then((r) => {
        if (r) setRun(r);
        if (r?.status !== 'running') localStorage.removeItem('inboxflow.activeRunId');
      })
      .catch(() => {
        localStorage.removeItem('inboxflow.activeRunId');
      });
  }, []);

  // Keep the sidebar Test Runs count in sync.
  useEffect(() => {
    api.listRuns().then((rs) => setRunsCount(rs.length)).catch(() => {});
  }, [runsRefreshKey, run?.status]);

  // Poll inbox unread count for the rail badge.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await api.inbox();
        if (!cancelled) setInboxUnread(r.unreadCount);
      } catch {
        /* gmail not connected yet, ignore */
      }
    }
    tick();
    const t = window.setInterval(tick, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Persist / clear the active run id whenever the run changes status.
  useEffect(() => {
    if (run?.status === 'running') {
      localStorage.setItem('inboxflow.activeRunId', run.id);
    } else if (run) {
      localStorage.removeItem('inboxflow.activeRunId');
    }
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (!run) return;
    if (run.status !== 'running') return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const updated = await api.getRun(run.id);
        setRun(updated);
        if (updated.status !== 'running') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          const rep = await api.getReport(updated.id);
          setReport(rep);
        }
      } catch (e) {
        console.error(e);
      }
    }, 1500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [run?.id, run?.status]);

  function onFlowTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setFlowText(e.target.value);
    // Clear the parsed-flow preview in the same batched render — no separate effect tick.
    if (parsedFlow) setParsedFlow(null);
  }

  const [stopping, setStopping] = useState(false);
  async function handleStop() {
    if (!run || run.status !== 'running' || stopping) return;
    if (!window.confirm('Stop this test run? In-flight steps will be aborted.')) return;
    setStopping(true);
    try {
      await api.cancelRun(run.id);
    } catch (err) {
      console.error('cancel failed', err);
    }
  }
  // Reset the "Stopping…" indicator once the server confirms the run has ended.
  useEffect(() => {
    if (run?.status !== 'running' && stopping) setStopping(false);
  }, [run?.status, stopping]);

  async function handleStart() {
    if (busy) return;
    if (!flowText.trim()) {
      alert('Describe the campaign flow first.');
      return;
    }
    if (!config?.gmailConfigured) {
      alert('Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
      return;
    }
    if (!config.gmailConnected) {
      alert('Connect a Gmail account before starting a production test run.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.createRun({ expectedFlowText: flowText });
      setParsedFlow(created.expectedFlow);
      // Optimistically mark the run as running so the button flips immediately;
      // the polling effect will overwrite this with real server state.
      setRun({ ...created, status: 'running' });
      await api.startRun(created.id);
      // Pull the fresh server state so personas + step timestamps are accurate.
      try {
        const fresh = await api.getRun(created.id);
        setRun(fresh);
      } catch {}
      setReport(null);
      setRunsRefreshKey((k) => k + 1);
    } catch (e) {
      console.error(e);
      alert('Failed to start run: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openReport() {
    if (!run) {
      setModalOpen(true);
      return;
    }
    try {
      const rep = await api.getReport(run.id);
      setReport(rep);
      setModalOpen(true);
    } catch (e) {
      console.error(e);
    }
  }

  async function connectGmail() {
    try {
      const { url } = await api.getGmailAuthUrl();
      window.location.href = url;
    } catch (e) {
      alert('Gmail OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable.');
    }
  }

  const blockers = useMemo(() => run?.findings?.filter((f) => f.severity === 'blocker').length || 0, [run]);
  const warnings = useMemo(() => run?.findings?.filter((f) => f.severity === 'warning').length || 0, [run]);

  const personas: PersonaConfig[] = run?.personas || parsedFlow?.personas || [];
  const headStatus = run?.status || 'draft';

  const headBadge =
    headStatus === 'running' ? (
      <span className="badge running">
        <span className="bd"></span>Running
      </span>
    ) : headStatus === 'failed' ? (
      <span className="badge failed">
        <span className="bd"></span>Failed
      </span>
    ) : headStatus === 'ready' ? (
      <span className="badge ready">
        <span className="bd"></span>Ready
      </span>
    ) : (
      <span className="badge draft">
        <span className="bd"></span>Draft
      </span>
    );

  const inferredName = run?.campaignName || '';
  const parsedSummary = parsedFlow
    ? `${parsedFlow.totalEmails || '—'} emails, ${parsedFlow.personas.length} persona${parsedFlow.personas.length === 1 ? '' : 's'}, ${parsedFlow.steps?.length || 0} step${(parsedFlow.steps?.length || 0) === 1 ? '' : 's'}`
    : 'click Start to parse the prompt';

  const flowLine = parsedFlow
    ? parsedFlow.branches
        .map((b) => {
          const p = parsedFlow.personas.find((x) => x.id === b.personaId);
          return `${p?.displayName || b.personaId}: ${b.expected.join(' → ')}`;
        })
        .join('  ·  ')
    : '';

  return (
    <>
      <div className="app">
        <Sidebar
          config={config}
          onConnectGmail={connectGmail}
          view={view}
          onView={setView}
          runsCount={runsCount}
          inboxUnread={inboxUnread}
        />

        <main className="work">
          {view === 'test-runs' ? (
            <>
              <div className="work-head">
                <div>
                  <div className="crumb">Workspace <b>/</b> Test Runs</div>
                  <h1>Test Runs</h1>
                  <p className="sub">Past runs and their reports. Click "View report" to open the QA summary.</p>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => setView('new-test')}
                  style={{ flex: 'none' }}
                >
                  New Test
                </button>
              </div>
              <TestRunsList
                refreshKey={runsRefreshKey}
                onOpenReport={(rep) => {
                  setReport(rep);
                  setModalOpen(true);
                }}
                onResumeRun={(r) => {
                  setRun(r);
                  setView('new-test');
                }}
              />
            </>
          ) : view === 'inbox' ? (
            <InboxView onUnreadChange={setInboxUnread} />
          ) : (
            <>
              <div className="work-head">
                <div>
                  <div className="crumb">
                    Workspace <b>/</b> New Test
                  </div>
                  <h1>{inferredName || 'New Campaign Flow Test'}</h1>
                  <p className="sub">
                    Describe the journey in your own words. The agent infers personas, builds a step plan with timers, watches the connected Gmail account at each checkpoint, then writes a report tailored to the flow you described.
                  </p>
                </div>
                {headBadge}
              </div>

              <section className="card">
                <div className="card-head">
                  <h2>Describe the campaign flow</h2>
                  <span className="hint">
                    Plain language. Include timers like "wait 10 minutes". The agent parses everything from this prompt.
                  </span>
                </div>
                <div className="flow-wrap">
                  <textarea
                    className="flow-area"
                    spellCheck={false}
                    value={flowText}
                    onChange={onFlowTextChange}
                    placeholder="e.g. After a user fills the signup form they get a welcome email. If they click the CTA within 5 minutes, send Email 2A; otherwise send Reminder 2B. Both branches then get a thank-you email after 10 minutes."
                  />
                  <div className="flow-foot">
                    <div className="parsed">
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <circle cx="7" cy="7" r="6" stroke="#1E7A4D" strokeWidth="1.3" />
                        <path
                          d="M4.4 7.1l1.8 1.8 3.4-3.6"
                          stroke="#1E7A4D"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Parsed: <b>{parsedSummary}</b>
                    </div>
                    <span className="summary-line">{flowLine}</span>
                  </div>
                  <div className="flow-actions">
                    <button className="btn btn-primary" onClick={handleStart} disabled={busy || run?.status === 'running'}>
                      {run?.status === 'running' ? (
                        <svg width="13" height="13" viewBox="0 0 14 14">
                          <circle
                            cx="7"
                            cy="7"
                            r="5"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            fill="none"
                            strokeDasharray="22"
                            strokeLinecap="round"
                          >
                            <animateTransform
                              attributeName="transform"
                              type="rotate"
                              from="0 7 7"
                              to="360 7 7"
                              dur="0.9s"
                              repeatCount="indefinite"
                            />
                          </circle>
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                          <path d="M3 2.5l8 4.5-8 4.5z" fill="currentColor" />
                        </svg>
                      )}
                      {run?.status === 'running'
                        ? 'Running'
                        : run && run.status !== 'draft'
                          ? 'Re-run test'
                          : 'Start Test Run'}
                    </button>
                    {run?.status === 'running' && (
                      <button
                        type="button"
                        className="btn"
                        onClick={handleStop}
                        disabled={stopping}
                        title="Cancel this test run"
                        style={{ marginLeft: 8 }}
                      >
                        <svg width="11" height="11" viewBox="0 0 14 14" style={{ marginRight: 6 }}>
                          <rect x="3" y="3" width="8" height="8" fill="currentColor" rx="1" />
                        </svg>
                        {stopping ? 'Stopping…' : 'Stop'}
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <h2>Test personas</h2>
                  <span className="hint">{personas.length} parsed from your prompt</span>
                </div>
                <div className="card-body">
                  {personas.length === 0 ? (
                    <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                      Click Start Test Run. The agent will infer the personas from your prompt and show them here.
                    </div>
                  ) : (
                    <div className="persona-grid">
                      {personas.map((p) => {
                        const s = personaStatusText(p.status);
                        return (
                          <div key={p.id} className="persona">
                            <div className="persona-top">
                              <div className="persona-id">
                                <div className="p-avatar">{p.displayName.charAt(0)}</div>
                                <h3>{p.displayName}</h3>
                              </div>
                              <span className={`mini-status ${s.cls}`}>{s.label}</span>
                            </div>
                            <dl>
                              <dt>Alias</dt>
                              <dd className="mono">{p.alias}</dd>
                              <dt>Action</dt>
                              <dd>{p.behavior}</dd>
                            </dl>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>

              <Activity
                events={run?.events || []}
                status={headStatus}
                paths={run?.paths || []}
                personas={run?.personas || parsedFlow?.personas || []}
                blockers={blockers}
                warnings={warnings}
                onOpenReport={openReport}
              />
            </>
          )}
        </main>
      </div>

      <ReportModal
        report={report}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        gmailConnected={!!config?.gmailConnected}
        onRetest={async () => {
          if (!report) return;
          if (!config?.gmailConnected) {
            alert('Connect a Gmail account before re-testing.');
            return;
          }
          setModalOpen(false);
          // Re-use the failed run's prompt to launch a fresh run.
          try {
            setBusy(true);
            const original = await api.getRun(report.testRunId);
            const created = await api.createRun({
              expectedFlowText: original.expectedFlowText,
            });
            setParsedFlow(created.expectedFlow);
            setFlowText(created.expectedFlowText);
            setRun(created);
            setReport(null);
            api.startRun(created.id).catch((e) => console.error(e));
            setView('new-test');
            setRunsRefreshKey((k) => k + 1);
          } catch (e) {
            alert('Re-test failed: ' + (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
