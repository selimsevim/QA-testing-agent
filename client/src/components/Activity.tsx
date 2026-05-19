import { useState } from 'react';
import type { AgentEvent, PathResult, PersonaConfig, RunStatus } from '../types';

function timeOnly(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
}

export function Activity(props: {
  events: AgentEvent[];
  status: RunStatus;
  paths: PathResult[];
  personas: PersonaConfig[];
  blockers: number;
  warnings: number;
  onOpenReport: () => void;
}) {
  const { events, status, paths, personas, blockers, warnings, onOpenReport } = props;
  const live = status === 'running';
  const hasResults = paths.length > 0 || blockers > 0 || warnings > 0 || status !== 'draft';
  const [collapsed, setCollapsed] = useState(false);
  const personaName = (id: string) => personas.find((p) => p.id === id)?.displayName || id;

  if (status === 'draft' && events.length === 0 && paths.length === 0 && personas.length === 0) {
    return null;
  }

  const renderStatusCell = (p: PathResult) => {
    if (p.status === 'pending') {
      return (
        <div className="v pending">
          <span className="d"></span>Pending
        </div>
      );
    }
    if (p.status === 'passed') {
      return (
        <div className="v pass">
          <span className="d"></span>Passed
        </div>
      );
    }
    if (p.status === 'failed') {
      return (
        <div className="v fail">
          <span className="d"></span>Failed
        </div>
      );
    }
    return (
      <div className="v pending">
        <span className="d"></span>Running
      </div>
    );
  };

  const overallBadge =
    status === 'running' ? (
      <span className="badge running">
        <span className="bd"></span>Running
      </span>
    ) : status === 'failed' ? (
      <span className="badge failed">
        <span className="bd"></span>Failed
      </span>
    ) : status === 'ready' ? (
      <span className="badge ready">
        <span className="bd"></span>Ready
      </span>
    ) : (
      <span className="badge draft">
        <span className="bd"></span>Draft
      </span>
    );

  const pathRows: { persona: string; row: PathResult }[] = paths.length
    ? paths.map((p) => ({ persona: p.persona, row: p }))
    : personas.map((p) => ({
        persona: p.id,
        row: { persona: p.id, status: 'pending', expected: [], actual: [], notes: [] },
      }));

  return (
    <section className={`activity card reveal d4 ${collapsed ? 'collapsed' : ''}`}>
      <div className="act-head" onClick={() => setCollapsed((v) => !v)} role="button" aria-expanded={!collapsed}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg className="chev" width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2>Agent activity</h2>
        </div>
        <span className={`live ${live ? 'on' : ''}`}>
          <span className="ld"></span>
          {live ? 'Live' : 'Idle'}
        </span>
      </div>

      <div className="timeline">
        {events.length === 0 && (
          <div className="timeline-empty">No activity yet. Start a test run to watch the agent work.</div>
        )}
        {events.map((e) => (
          <div key={e.id} className={`tl-item ${e.state}`}>
            <div className="tl-node"></div>
            <div className="tl-title">{e.title}</div>
            <div className="tl-meta">
              {timeOnly(e.timestamp)}
              {e.detail ? ` · ${e.detail}` : ''}
            </div>
          </div>
        ))}
      </div>

      {hasResults && (
        <div className="result">
          <div className="result-top">
            <span className="eyebrow">Current result</span>
            {overallBadge}
          </div>
          <div className="res-grid">
            {pathRows.map(({ persona, row }) => (
              <div className="res-cell" key={persona}>
                <div className="k">{personaName(persona)} path</div>
                {renderStatusCell(row)}
              </div>
            ))}
            <div className="res-cell">
              <div className="k">Blockers</div>
              <div className="v num">{blockers}</div>
            </div>
            <div className="res-cell">
              <div className="k">Warnings</div>
              <div className="v num">{warnings}</div>
            </div>
          </div>
          <div className="res-foot">
            <button className="btn btn-secondary" onClick={onOpenReport}>
              Open run report
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
