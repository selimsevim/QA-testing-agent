import { useEffect, useRef } from 'react';
import type {
  CheckStatus,
  EmailContentReport,
  FlowCheck,
  PersonaReplay,
  Proof,
  QaReport,
  ReadinessSummary,
  ReplayStep,
  TestRunReport,
} from '../types';

export function ReportModal({
  report,
  open,
  onClose,
  gmailConnected,
  onRetest,
}: {
  report: TestRunReport | null;
  open: boolean;
  onClose: () => void;
  gmailConnected: boolean;
  onRetest?: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!report) {
    return (
      <div className={`scrim ${open ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="m-head">
            <div>
              <div className="rpt-eyebrow">Test Run Report</div>
              <h2>No report yet</h2>
            </div>
            <button className="x" onClick={onClose} aria-label="Close">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="m-body">
            <p style={{ color: 'var(--ink-2)' }}>Start a test run to generate a launch-readiness report.</p>
          </div>
        </div>
      </div>
    );
  }

  const qa: QaReport | undefined = report.qaReport;
  const isRunning = report.overall === 'running';
  const result = qa?.result || (report.overall === 'failed' ? 'failed' : 'passed');
  const recommendation =
    qa?.recommendation || (result === 'failed' ? 'Do not launch' : 'Ready to launch');
  const verdictClass = isRunning ? 'running' : result === 'failed' ? 'fail' : 'ready';
  const verdictMark = isRunning ? '·' : result === 'failed' ? '❌' : '✅';
  const verdictText = isRunning ? 'Processing' : result === 'failed' ? 'Failed' : 'Passed';

  function handleExportPdf() {
    const title = `${report!.campaignName} — ${report!.testRunId}`;
    const prev = document.title;
    document.title = title;
    window.print();
    setTimeout(() => {
      document.title = prev;
    }, 500);
  }

  function openInGmail() {
    if (gmailConnected) {
      const q = encodeURIComponent(report!.campaignName);
      window.open(`https://mail.google.com/mail/u/0/#search/${q}`, '_blank');
    } else {
      window.open('about:blank', '_blank');
    }
  }

  const flowChecks: FlowCheck[] = qa?.flowChecks || [];
  const emails: EmailContentReport[] = qa?.emails || [];
  const replay: PersonaReplay[] = qa?.replay || [];
  const readiness: ReadinessSummary | undefined = qa?.readiness;

  return (
    <div className={`scrim ${open ? 'show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Test Run Report">
        <div className="m-head">
          <div>
            <div className="rpt-eyebrow">InboxFlow Test Report</div>
            <h2>{report.campaignName}</h2>
            <div className="qa-meta">
              <span className="codey">{report.testRunId}</span>
              <span>Result: <b>{verdictMark} {verdictText}</b></span>
              <span>Recommendation: <b>{recommendation}</b></span>
            </div>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className={`verdict ${verdictClass}`}>
          <div className="vmark">{verdictMark}</div>
          <div className="vtxt">
            {verdictText}. <span>{isRunning ? 'Report will populate when the run finishes.' : recommendation + '.'}</span>
          </div>
        </div>

        <div className="m-body">
          {readiness && !isRunning && (
            <div className="m-section readiness">
              <span className="eyebrow">Campaign readiness</span>
              <div className="readiness-card">
                <div className="readiness-row">
                  <span className="rk">Decision</span>
                  <span className={`rv ${readiness.decision === 'Do not launch' ? 'bad' : 'good'}`}>{readiness.decision}</span>
                </div>
                {readiness.topFixes.length > 0 && (
                  <div className="readiness-row">
                    <span className="rk">Top fixes</span>
                    <ul className="readiness-fixes">
                      {readiness.topFixes.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="readiness-row">
                  <span className="rk">Re-test required</span>
                  <span className="rv">{readiness.retestRequired ? 'Yes' : 'No'}</span>
                </div>
                {readiness.retestRequired && onRetest && (
                  <button className="btn btn-primary readiness-retest" onClick={onRetest}>
                    Re-test now
                  </button>
                )}
              </div>
            </div>
          )}

          {replay.length > 0 && !isRunning && (
            <div className="m-section">
              <span className="eyebrow">Persona replay</span>
              <div className="replay-list">
                {replay.map((r) => (
                  <ReplayRow key={r.personaId} replay={r} />
                ))}
              </div>
            </div>
          )}

          <div className="m-section">
            <span className="eyebrow">1. Flow</span>
            <div className="qa-table-wrap">
              <table className="qa-table">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Expected</th>
                    <th>Actual</th>
                    <th style={{ width: 120 }}>Status</th>
                    <th>Fix &amp; proof</th>
                  </tr>
                </thead>
                <tbody>
                  {flowChecks.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-row">No flow checks recorded.</td>
                    </tr>
                  ) : (
                    flowChecks.map((c, i) => (
                      <tr key={i}>
                        <td>{c.name}</td>
                        <td className="mono-cell">{c.expected || '—'}</td>
                        <td className="mono-cell">{c.actual || '—'}</td>
                        <td><StatusBadge status={c.status} /></td>
                        <td>
                          {c.status === 'pass' ? '—' : c.fix || '—'}
                          <Proofs proofs={c.proofs} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="m-section">
            <span className="eyebrow">2. Content &amp; Links</span>
            {emails.length === 0 ? (
              <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>No emails were captured during this run.</p>
            ) : (
              emails.map((er, idx) => (
                <div key={idx} className="qa-email-block">
                  <h4 className="qa-email-head">
                    {er.emailLabel} <span className="qa-email-persona">— {er.personaDisplay}</span>
                    {er.gmailUrl && (
                      <a className="qa-email-link" href={er.gmailUrl} target="_blank" rel="noreferrer">
                        open in Gmail ↗
                      </a>
                    )}
                  </h4>
                  <div className="qa-email-meta">
                    {er.subject && <div><span className="mk">Subject:</span> {er.subject}</div>}
                    {er.from && <div><span className="mk">From:</span> {er.from}</div>}
                    {er.to && <div><span className="mk">To:</span> {er.to}</div>}
                    {er.receivedAt && <div><span className="mk">Received:</span> {new Date(er.receivedAt).toLocaleString()}</div>}
                  </div>
                  {(er.bodyHtml || er.bodyText) && (
                    <div className="qa-email-preview">
                      <div className="qa-email-preview-head">Email content (visual proof)</div>
                      {er.bodyHtml ? (
                        <EmailFrame html={er.bodyHtml} title={`${er.emailLabel} preview`} />
                      ) : (
                        <pre className="qa-email-preview-body text">{er.bodyText}</pre>
                      )}
                    </div>
                  )}
                  <div className="qa-table-wrap">
                    <table className="qa-table">
                      <thead>
                        <tr>
                          <th style={{ width: '22%' }}>Check</th>
                          <th style={{ width: 120 }}>Status</th>
                          <th>Finding</th>
                          <th style={{ width: '36%' }}>Fix &amp; proof</th>
                        </tr>
                      </thead>
                      <tbody>
                        {er.checks.map((c, i) => (
                          <tr key={i}>
                            <td>{c.name}</td>
                            <td><StatusBadge status={c.status} finding={c.finding} mutePassWithoutFinding /></td>
                            <td>{c.status === 'pass' ? '—' : c.finding || '—'}</td>
                            <td>
                              {c.status === 'pass' ? '—' : c.fix || '—'}
                              <Proofs proofs={c.proofs} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="m-foot">
          <div className="left">{report.testRunId}</div>
          <div className="acts">
            {readiness?.retestRequired && onRetest && (
              <button className="btn btn-secondary" onClick={onRetest}>
                Re-test
              </button>
            )}
            <button className="btn btn-secondary" onClick={openInGmail} disabled={!gmailConnected}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5 4.5L8 7 5 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              Open in Gmail
            </button>
            <button className="btn btn-primary" onClick={handleExportPdf} disabled={isRunning}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M7 2v7M4 6.5l3 3 3-3M2.5 11.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export PDF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  finding,
  mutePassWithoutFinding = false,
}: {
  status: CheckStatus;
  finding?: string;
  mutePassWithoutFinding?: boolean;
}) {
  if (status === 'pass') {
    // For Content & Links rows we mute pass when there's nothing to verify
    // (e.g. no personalization in the email). For Flow rows a pass IS a real
    // positive — the expected/actual columns are themselves the confirmation.
    if (mutePassWithoutFinding && !(finding && finding.trim())) {
      return <span className="qa-status qa-na">—</span>;
    }
    return <span className="qa-status qa-pass">✅ Passed</span>;
  }
  if (status === 'fail') return <span className="qa-status qa-fail">❌ Failed</span>;
  return <span className="qa-status qa-warn">⚠️ Warning</span>;
}

function Proofs({ proofs }: { proofs?: Proof[] }) {
  if (!proofs || !proofs.length) return null;
  return (
    <ul className="proof-list">
      {proofs.map((p, i) => (
        <li key={i} className={`proof proof-${p.kind}`}>{renderProof(p)}</li>
      ))}
    </ul>
  );
}

function renderProof(p: Proof) {
  if (p.kind === 'email' && (p.subject || p.gmailUrl)) {
    return (
      <>
        <span className="proof-tag">email</span>
        {p.gmailUrl ? (
          <a href={p.gmailUrl} target="_blank" rel="noreferrer">{p.subject || 'open in Gmail'}</a>
        ) : (
          <span>{p.subject}</span>
        )}
        {p.receivedAt && <span className="proof-ts">{formatProofTime(p.receivedAt)}</span>}
      </>
    );
  }
  if (p.kind === 'link' && p.url) {
    return (
      <>
        <span className="proof-tag">link</span>
        <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>
        {p.httpStatus && <span className="proof-ts">HTTP {p.httpStatus}</span>}
        {p.note && <span className="proof-note">{p.note}</span>}
      </>
    );
  }
  if (p.note) {
    return (
      <>
        <span className="proof-tag">{p.kind === 'note' ? 'note' : p.kind}</span>
        <span className="proof-note">{p.note}</span>
      </>
    );
  }
  if (p.timestamp) {
    return (
      <>
        <span className="proof-tag">time</span>
        <span>{formatProofTime(p.timestamp)}</span>
      </>
    );
  }
  return null;
}

function formatProofTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function ReplayRow({ replay }: { replay: PersonaReplay }) {
  const outcomeCls = replay.outcome === 'passed' ? 'good' : replay.outcome === 'failed' ? 'bad' : 'warn';
  return (
    <div className={`replay-row replay-${outcomeCls}`}>
      <div className="replay-name">{replay.personaName}</div>
      <div className="replay-steps">
        {replay.steps.map((s, i) => (
          <span key={i} className="replay-step-wrap">
            {i > 0 && <span className="replay-arrow">→</span>}
            <ReplayStepPill step={s} />
          </span>
        ))}
      </div>
    </div>
  );
}

function EmailFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);

  function resize() {
    const f = ref.current;
    if (!f) return;
    try {
      const doc = f.contentDocument;
      if (!doc) return;
      // Use the body's scrollHeight rather than documentElement to avoid the
      // page-wide background table padding inflating the height.
      const h = Math.max(
        doc.body?.scrollHeight || 0,
        doc.documentElement?.scrollHeight || 0,
        320,
      );
      f.style.height = `${Math.min(h + 4, 2400)}px`;
    } catch {
      /* sandboxed: leave default */
    }
  }

  return (
    <iframe
      ref={ref}
      className="qa-email-preview-frame"
      srcDoc={html}
      // allow-same-origin lets the parent read contentDocument.scrollHeight to auto-size.
      // We deliberately omit allow-scripts so JS inside the email cannot execute.
      sandbox="allow-same-origin"
      title={title}
      loading="lazy"
      onLoad={resize}
    />
  );
}

function ReplayStepPill({ step }: { step: ReplayStep }) {
  const cls = step.status === 'ok' ? 'good' : step.status === 'bad' ? 'bad' : 'neutral';
  const content = (
    <>
      {step.kind === 'email_received' && <span className="replay-icon">✉</span>}
      {step.kind === 'action' && <span className="replay-icon">↪</span>}
      {step.kind === 'verdict' && <span className="replay-icon">{step.status === 'ok' ? '✓' : step.status === 'bad' ? '✕' : '·'}</span>}
      {step.label}
    </>
  );
  if (step.gmailUrl) {
    return (
      <a className={`replay-step ${cls}`} href={step.gmailUrl} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return <span className={`replay-step ${cls}`}>{content}</span>;
}
