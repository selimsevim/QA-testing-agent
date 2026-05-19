import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TestRun, TestRunReport } from '../types';

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return iso;
  }
}

function StatusPill({ status }: { status: TestRun['status'] }) {
  const cls = status === 'failed' ? 'failed' : status === 'ready' ? 'ready' : status === 'running' ? 'running' : 'draft';
  const label = status === 'failed' ? 'Failed' : status === 'ready' ? 'Passed' : status === 'running' ? 'Processing' : 'Draft';
  return (
    <span className={`badge ${cls}`}>
      <span className="bd"></span>
      {label}
    </span>
  );
}

export function TestRunsList({
  refreshKey,
  onOpenReport,
  onResumeRun,
}: {
  refreshKey: number;
  onOpenReport: (report: TestRunReport) => void;
  onResumeRun: (run: TestRun) => void;
}) {
  const [runs, setRuns] = useState<TestRun[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rs = await api.listRuns();
        if (!cancelled) setRuns(rs);
      } catch (e) {
        console.error(e);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // While any run is running, keep this list fresh.
  useEffect(() => {
    if (!runs || !runs.some((r) => r.status === 'running')) return;
    const t = window.setInterval(async () => {
      try {
        const rs = await api.listRuns();
        setRuns(rs);
      } catch {}
    }, 2000);
    return () => window.clearInterval(t);
  }, [runs]);

  async function openOrResume(r: TestRun) {
    setBusy(r.id);
    try {
      if (r.status === 'running') {
        const fresh = await api.getRun(r.id);
        onResumeRun(fresh);
      } else {
        const rep = await api.getReport(r.id);
        onOpenReport(rep);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Test Runs</h2>
        <span className="hint">{runs ? `${runs.length} total` : 'loading…'}</span>
      </div>
      <div className="table-wrap">
        <table className="runs">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Run</th>
              <th>Campaign</th>
              <th style={{ width: 170 }}>Started</th>
              <th style={{ width: 130 }}>Result</th>
              <th style={{ width: 140 }}></th>
            </tr>
          </thead>
          <tbody>
            {!runs ? (
              <tr>
                <td colSpan={5} className="empty-row">Loading…</td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty-row">No test runs yet. Run one from "New Test".</td>
              </tr>
            ) : (
              runs.map((r) => (
                <tr
                  key={r.id}
                  className={r.status === 'running' ? 'row-running' : undefined}
                  onClick={() => openOrResume(r)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono-cell">{r.id}</td>
                  <td>{r.campaignName}</td>
                  <td className="mono-cell">{fmtDate(r.startedAt || r.createdAt)}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      style={{ height: 30, fontSize: 12.5, padding: '0 12px' }}
                      disabled={busy === r.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        openOrResume(r);
                      }}
                    >
                      {busy === r.id ? 'Opening…' : r.status === 'running' ? 'View live' : 'View report'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
