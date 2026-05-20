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

type DemoCampaignKey = 'welcome';
interface DemoCampaign {
  label: string;
  tagline: string;
  prompt: string;
  triggersConfigured: boolean;  // whether the server has SFMC triggers wired up for this preset
}
// Mirrors server/src/services/demoPresets.ts. The prompt below must stay in sync
// with the server preset — the server uses its own copy when demoCampaign is set,
// but the client shows this text in the read-only textarea so the user sees
// exactly what the agent will read.
const DEMO_CAMPAIGNS: Record<DemoCampaignKey, DemoCampaign> = {
  welcome: {
    label: 'Welcome Campaign — Engagement check with timer',
    tagline: 'Two emails. Reminder fires only if the recipient does not click within 3 minutes. Triggers real SFMC entry events.',
    prompt:
      'Welcome Campaign has two emails. Two test contacts are used: one with the alias +welcomeclicker and one with the alias +welcomenonclicker. The first email is sent to both contacts and contains a "Finish setup" CTA. If the recipient with the +welcomeclicker alias clicks the "Finish setup" CTA, nothing else happens. If the recipient with the +welcomenonclicker alias does not click within 3 minutes, send a reminder email with a "Verify email address" CTA.',
    triggersConfigured: true,
  },
};

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
  const [demoCompression, setDemoCompression] = useState<number>(60);

  const [run, setRun] = useState<TestRun | null>(null);
  const [report, setReport] = useState<TestRunReport | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AppView>('new-test');
  const [runsCount, setRunsCount] = useState<number>(0);
  const [runsRefreshKey, setRunsRefreshKey] = useState<number>(0);
  const [inboxUnread, setInboxUnread] = useState<number>(0);
  const [demoCampaign, setDemoCampaign] = useState<DemoCampaignKey>('welcome');

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

  // Poll inbox unread count for the rail badge. Only needs to be alive on demo /
  // jury walkthroughs, but it's cheap enough to run everywhere.
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

  // When the user is in Demo view, keep flowText synced to the selected campaign
  // so handleStart sends the right prompt to the server.
  useEffect(() => {
    if (view === 'demo') {
      setFlowText(DEMO_CAMPAIGNS[demoCampaign].prompt);
      setParsedFlow(null);
    }
  }, [view, demoCampaign]);

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
    setBusy(true);
    try {
      // In Demo view we send demoCampaign and let the server apply the preset
      // (including SFMC triggers). Otherwise it's a free-form prompt.
      const created = await api.createRun(
        view === 'demo'
          ? { demoCampaign, demoTimeCompression: config?.mode === 'demo' ? demoCompression : 1 }
          : { expectedFlowText: flowText, demoTimeCompression: config?.mode === 'demo' ? demoCompression : 1 },
      );
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
                    Workspace <b>/</b> {view === 'demo' ? 'Demo' : 'New Test'}
                  </div>
                  <h1>{inferredName || (view === 'demo' ? 'Run a demo scenario' : 'New Campaign Flow Test')}</h1>
                  <p className="sub">
                    {view === 'demo'
                      ? 'Pick a pre-configured campaign. The agent will run the same flow it would for any custom prompt — inferring personas, watching the inbox, and producing the QA report.'
                      : 'Describe the journey in your own words. The agent infers personas, builds a step plan with timers, watches the seed inbox at each checkpoint, then writes a report tailored to the flow you described.'}
                  </p>
                </div>
                {headBadge}
              </div>

              <section className="card">
                <div className="card-head">
                  <h2>{view === 'demo' ? 'Pick a demo campaign' : 'Describe the campaign flow'}</h2>
                  <span className="hint">
                    {view === 'demo'
                      ? 'Choose one of two pre-built flows. The prompt below is what the agent will read — exactly as if you typed it yourself.'
                      : 'Plain language. Include timers like "wait 10 minutes". The agent parses everything from this prompt.'}
                  </span>
                </div>
                <div className="flow-wrap">
                  {view === 'demo' && (
                    <div className="demo-picker">
                      <label htmlFor="demo-campaign">Campaign</label>
                      <select
                        id="demo-campaign"
                        value={demoCampaign}
                        onChange={(e) => {
                          const key = e.target.value as DemoCampaignKey;
                          setDemoCampaign(key);
                          setFlowText(DEMO_CAMPAIGNS[key].prompt);
                          setParsedFlow(null);
                        }}
                      >
                        {(Object.keys(DEMO_CAMPAIGNS) as DemoCampaignKey[]).map((k) => (
                          <option key={k} value={k}>{DEMO_CAMPAIGNS[k].label}</option>
                        ))}
                      </select>
                      <div className="demo-tagline">{DEMO_CAMPAIGNS[demoCampaign].tagline}</div>
                      {DEMO_CAMPAIGNS[demoCampaign].triggersConfigured && config && !config.sfmcConfigured && (
                        <div className="demo-warning">
                          ⚠️ SFMC isn't configured. Set <code>SFMC_SUBDOMAIN</code>, <code>SFMC_CLIENT_ID</code>, <code>SFMC_CLIENT_SECRET</code>, and <code>SFMC_ACCOUNT_ID</code> in <code>.env</code> so the demo can fire real entry events. The run will still start but no emails will arrive.
                        </div>
                      )}
                      {!DEMO_CAMPAIGNS[demoCampaign].triggersConfigured && (
                        <div className="demo-warning">
                          ⚠️ This preset's SFMC triggers haven't been configured yet (no ContactKey / EventDefinitionKey). The agent will parse the prompt and start watching, but no entry events will fire.
                        </div>
                      )}
                    </div>
                  )}
                  <textarea
                    className="flow-area"
                    spellCheck={false}
                    value={view === 'demo' ? DEMO_CAMPAIGNS[demoCampaign].prompt : flowText}
                    onChange={onFlowTextChange}
                    placeholder="e.g. After a user fills the signup form they get a welcome email. If they click the CTA within 5 minutes, send Email 2A; otherwise send Reminder 2B. Both branches then get a thank-you email after 10 minutes."
                    readOnly={view === 'demo'}
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
                    {config?.mode === 'demo' && (
                      <span className="hint">
                        Demo time compression:{' '}
                        <select
                          value={demoCompression}
                          onChange={(e) => setDemoCompression(Number(e.target.value))}
                          style={{ background: 'transparent', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px', color: 'var(--ink)', font: 'inherit' }}
                        >
                          <option value={1}>real time</option>
                          <option value={6}>6×</option>
                          <option value={60}>60×</option>
                          <option value={600}>600×</option>
                        </select>
                      </span>
                    )}
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
          setModalOpen(false);
          // Re-use the failed run's prompt to launch a fresh run.
          try {
            setBusy(true);
            const created = await api.createRun({
              expectedFlowText: (await api.getRun(report.testRunId)).expectedFlowText,
              demoTimeCompression: config?.mode === 'demo' ? demoCompression : 1,
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
