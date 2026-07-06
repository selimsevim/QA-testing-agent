import { nanoid } from 'nanoid';
import { AgentEvent, FlowStep, Persona, QaReport, TestRun } from '../types';
import { getTestRun, listProcessedEmailKeys, recordProcessedEmails, updateTestRun } from './store';
import { applyLabel, ensureLabel, syncMessages } from './gmailService';
import { checkEmailLinks, performPersonaAction } from './linkChecker';
import { generateQaReport } from './geminiService';
import { validateFlow } from './flowValidator';

function nowIso() {
  return new Date().toISOString();
}

function pushEvent(runId: string, ev: Omit<AgentEvent, 'id'>) {
  updateTestRun(runId, (r) => {
    r.events.push({ id: 'e_' + nanoid(8), ...ev });
  });
}

function markPersonaStatus(runId: string, persona: Persona, status: any) {
  updateTestRun(runId, (r) => {
    const p = r.personas.find((x) => x.id === persona);
    if (p) p.status = status;
  });
}

function formatRemaining(ms: number): string {
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / (60 * 60_000)).toFixed(1)}h`;
}

// Walks the run's expectedFlow.steps sequentially. Wait steps use setTimeout in real time
// so the polling client sees live progress.
export async function runStepPlan(runId: string): Promise<void> {
  const start = getTestRun(runId);
  if (!start) return;

  updateTestRun(runId, (r) => {
    r.status = 'running';
    r.startedAt = nowIso();
    r.events = [];
    r.emails = [];
    r.actions = [];
    r.findings = [];
    r.paths = [];
    r.currentStepIndex = 0;
    r.steps = (r.expectedFlow.steps || []).map((s) => ({ ...s, state: 'pending' as const }));
    r.personas = r.personas.map((p) => ({ ...p, status: 'watching' }));
  });

  const startRun = getTestRun(runId)!;
  // Nested label so Gmail sidebar shows "InboxFlow Tests" with each run as a sub-folder.
  // Format: "InboxFlow Tests/2026-05-19 03:37 - Subscription Confirmation"
  const labelName = `InboxFlow Tests/${formatLabelTimestamp(new Date())} - ${startRun.campaignName}`;
  const labelId = await ensureLabel(labelName);
  updateTestRun(runId, (r) => {
    r.gmailLabelName = labelName;
    r.gmailLabelId = labelId || undefined;
  });
  pushEvent(runId, {
    timestamp: nowIso(),
    title: labelId ? `Gmail folder ready: ${labelName}` : `Gmail folder ${labelName} could not be created`,
    detail: labelId ? 'Captured emails will be moved into this folder.' : 'Continuing without labeling.',
    state: labelId ? 'done' : 'fail',
  });

  const fresh = getTestRun(runId)!;
  const steps = fresh.steps || [];

  for (let i = 0; i < steps.length; i++) {
    if (isCancelled(runId)) {
      finalizeCancelled(runId);
      return;
    }
    const step = steps[i];
    updateTestRun(runId, (r) => {
      r.currentStepIndex = i;
      if (r.steps) r.steps[i] = { ...r.steps[i], state: 'active', startedAt: nowIso() };
    });

    try {
      await executeStep(runId, step);
      updateTestRun(runId, (r) => {
        if (r.steps) r.steps[i] = { ...r.steps[i], state: 'done', endedAt: nowIso() };
      });
    } catch (err) {
      if (err instanceof RunCancelledError) {
        updateTestRun(runId, (r) => {
          if (r.steps) r.steps[i] = { ...r.steps[i], state: 'fail', endedAt: nowIso() };
        });
        finalizeCancelled(runId);
        return;
      }
      pushEvent(runId, {
        timestamp: nowIso(),
        title: `Step "${step.descr}" failed`,
        detail: (err as Error).message,
        state: 'fail',
      });
      updateTestRun(runId, (r) => {
        if (r.steps) r.steps[i] = { ...r.steps[i], state: 'fail', endedAt: nowIso() };
        r.status = 'failed';
        r.finishedAt = nowIso();
      });
      return;
    }
  }

  // The 'report' step is responsible for setting the canonical verdict from the
  // QA report (single source of truth). This block only emits the closing event.
  const final = getTestRun(runId);
  if (!final) return;
  const failed = final.status === 'failed';
  pushEvent(runId, {
    timestamp: nowIso(),
    title: `Final result: ${failed ? 'Failed' : 'Ready'}`,
    detail: final.recommendation || (failed ? 'do not launch' : 'ready to launch'),
    state: failed ? 'fail' : 'done',
  });
}

async function executeStep(runId: string, step: FlowStep): Promise<void> {
  const run = getTestRun(runId);
  if (!run) return;

  if (step.kind === 'start') {
    pushEvent(runId, { timestamp: nowIso(), title: step.descr || 'Test plan created', detail: `${run.expectedFlow.totalEmails} emails parsed`, state: 'done' });
    return;
  }

  if (step.kind === 'wait') {
    const target = step.durationMs || 0;
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || `Wait ${step.durationLabel || formatRemaining(target)}`,
      state: 'active',
    });
    updateTestRun(runId, (r) => {
      r.nextStepAt = new Date(Date.now() + target).toISOString();
    });
    try {
      await cancellableSleep(runId, target);
    } finally {
      updateTestRun(runId, (r) => {
        r.nextStepAt = undefined;
      });
    }
    pushEvent(runId, { timestamp: nowIso(), title: 'Wait complete', detail: step.durationLabel, state: 'done' });
    return;
  }

  if (step.kind === 'sync') {
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || 'Sync inbox',
      detail: run.seedInbox ? `Querying ${run.seedInbox} via Gmail API` : 'Querying the connected Gmail account',
      state: 'active',
    });

    const aliasList = run.personas.map((p) => p.alias).join(', ');
    // Carry forward labels assigned in earlier syncs so the positional
    // fallback in inferEmailLabel can pick the next-expected label.
    const alreadyReceivedByPersona: Record<string, string[]> = {};
    for (const e of run.emails) {
      (alreadyReceivedByPersona[e.persona] ||= []).push(e.emailLabel);
    }
    // Cross-run dedupe: skip emails already processed for this campaign in an earlier run.
    const excludeKeys = listProcessedEmailKeys(run.campaignName);
    throwIfCancelled(runId);
    const { emails, query, totalScanned, droppedNoPersona, droppedAlreadyProcessed } = await syncMessages({
      campaignName: run.campaignName,
      seedInbox: run.seedInbox,
      personas: run.personas,
      expectedFlow: run.expectedFlow,
      alreadyReceivedByPersona,
      excludeKeys,
    });
    throwIfCancelled(runId);
    // Merge: keep all previously-seen emails by id
    const existing = new Set(run.emails.map((e) => e.id));
    const newOnes = emails.filter((e) => !existing.has(e.id));
    // Record so the NEXT run of this campaign doesn't double-count these.
    const aliasByPersonaId: Record<string, string> = {};
    for (const p of run.personas) aliasByPersonaId[p.id] = p.alias;
    recordProcessedEmails(
      run.campaignName,
      run.id,
      newOnes
        .filter((e) => aliasByPersonaId[e.persona])
        .map((e) => ({ gmailId: e.id, alias: aliasByPersonaId[e.persona], emailDate: e.date })),
    );
    let totalChecked = 0;
    let totalSkippedTracking = 0;
    let totalSkippedCta = 0;
    for (const e of newOnes) {
      throwIfCancelled(runId);
      const scan = await checkEmailLinks(e);
      e.brokenLinks = scan.broken;
      totalChecked += scan.checked.length;
      totalSkippedTracking += scan.skipped.filter((s) => s.reason === 'tracking').length;
      totalSkippedCta += scan.skipped.filter((s) => s.reason === 'cta').length;
    }
    updateTestRun(runId, (r) => {
      r.emails.push(...newOnes);
    });
    pushEvent(runId, {
      timestamp: nowIso(),
      title: `Scanned ${totalScanned} message${totalScanned === 1 ? '' : 's'}`,
      detail: `Gmail q: ${query} · looking for aliases ${aliasList} · ${newOnes.length} new, ${droppedNoPersona} dropped, ${droppedAlreadyProcessed} already processed in previous runs`,
      state: newOnes.length ? 'done' : 'fail',
    });
    // Move newly-captured messages from Inbox into this run's Gmail folder
    if (newOnes.length && run.gmailLabelId) {
      const applied = await applyLabel(newOnes.map((e) => e.id), run.gmailLabelId, { archiveFromInbox: true });
      if (applied > 0) {
        pushEvent(runId, {
          timestamp: nowIso(),
          title: `Moved ${applied} email${applied === 1 ? '' : 's'} to ${run.gmailLabelName}`,
          state: 'done',
        });
      }
    }
    if (newOnes.length) {
      pushEvent(runId, {
        timestamp: nowIso(),
        title: 'Link health scan',
        detail: `${totalChecked} link${totalChecked === 1 ? '' : 's'} probed · skipped ${totalSkippedCta} CTA + ${totalSkippedTracking} tracking redirector${totalSkippedTracking === 1 ? '' : 's'} (no false clicks recorded)`,
        state: 'done',
      });
    }
    // Update each persona who received a new email
    for (const e of newOnes) {
      markPersonaStatus(runId, e.persona, 'email_received');
      pushEvent(runId, {
        timestamp: nowIso(),
        title: `${labelDisplay(e.emailLabel)} received for ${e.persona}`,
        detail: `to "${e.to}" · subject "${e.subject}"`,
        state: 'done',
      });
    }
    return;
  }

  if (step.kind === 'action') {
    const persona = run.personas.find((p) => p.id === step.personaId);
    if (!persona) {
      pushEvent(runId, { timestamp: nowIso(), title: `Action skipped — persona ${step.personaId} not found`, state: 'fail' });
      return;
    }
    const target = run.emails.find((e) => e.persona === persona.id);
    const action = step.action || persona.behaviorAction;
    // Click-style actions need an email to act on. If no email arrived yet, skip cleanly
    // instead of recording a misleading "click failed" — that's not the journey's fault.
    if ((action === 'click_primary_cta' || action === 'open_only' || action === 'reply' || action === 'unsubscribe') && !target) {
      pushEvent(runId, {
        timestamp: nowIso(),
        title: `Skipped ${action.replace(/_/g, ' ')} for ${persona.displayName}`,
        detail: `no email with alias ${persona.alias} arrived yet — extend the wait or trigger the campaign`,
        state: 'fail',
      });
      return;
    }
    const result = await performPersonaAction(persona.id, action, target);
    updateTestRun(runId, (r) => r.actions.push(result));
    const verbMap: Record<string, string> = {
      clicked_primary_cta: 'Primary CTA clicked',
      no_click: 'Held back (no action)',
      opened: 'Email opened',
      replied: 'Replied',
      unsubscribed: 'Unsubscribed (recorded, not executed)',
      failed_to_click: 'CTA click failed',
    };
    // Show the destination URL the click resolved to, not the ESP tracking
    // redirect — a marketer reading the event cares about the landing page.
    const displayUrl = result.finalUrl || result.url || '';
    pushEvent(runId, {
      timestamp: nowIso(),
      title: verbMap[result.action] || result.action,
      detail: `${persona.displayName}${displayUrl ? ' · ' + displayUrl : ''}`,
      state: result.result === 'failed' ? 'fail' : 'done',
    });
    if (result.action === 'clicked_primary_cta' && result.result === 'clicked') {
      markPersonaStatus(runId, persona.id, 'cta_clicked');
    } else if (result.action === 'no_click') {
      markPersonaStatus(runId, persona.id, 'no_interaction');
    }
    return;
  }

  if (step.kind === 'validate') {
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || 'Flow validation running',
      detail: 'Branch + content checks. Reasoning passes can take a few seconds per email.',
      state: 'active',
    });
    // Validate step now only runs deterministic flow validation (branch correctness).
    // Per-email content/link reasoning happens in the `report` step via reasonOverEmail,
    // so we no longer call analyzeContent here. This is faster AND avoids duplicate
    // findings between the validator and the QA report.
    updateTestRun(runId, (r) => {
      const v = validateFlow({ expectedFlow: r.expectedFlow, emails: r.emails, actions: r.actions, personas: r.personas });
      r.findings = v.findings;
      r.paths = v.paths;
    });
    pushEvent(runId, { timestamp: nowIso(), title: 'Validation complete', state: 'done' });
    return;
  }

  if (step.kind === 'report') {
    throwIfCancelled(runId);
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || 'Generating report',
      detail: 'Probing every landing page and reasoning over each captured email — this is the deep check.',
      state: 'active',
    });
    const cur = getTestRun(runId)!;
    let qaReport: QaReport | undefined;
    try {
      qaReport = await generateQaReport({
        run: {
          campaignName: cur.campaignName,
          expectedFlowText: cur.expectedFlowText,
          expectedFlow: cur.expectedFlow,
        },
        paths: cur.paths,
        emails: cur.emails,
        actions: cur.actions,
      });
    } catch (err) {
      console.warn('[report] qa report generation failed:', (err as Error).message);
    }

    // Single canonical verdict source: the QA report. If generation failed (e.g.
    // Gemini outage), fall back to the validator-only signal so the run still
    // resolves to a status — but that fallback only runs when there is no qaReport.
    updateTestRun(runId, (r) => {
      r.finishedAt = nowIso();
      if (qaReport) {
        r.qaReport = qaReport;
        r.status = qaReport.result === 'failed' ? 'failed' : 'ready';
        r.recommendation = qaReport.recommendation;
      } else {
        const fallbackFailed =
          r.findings.some((f) => f.severity === 'blocker') ||
          r.paths.some((p) => p.status === 'failed');
        r.status = fallbackFailed ? 'failed' : 'ready';
        r.recommendation = fallbackFailed
          ? 'Do not launch until the flagged branch logic, content, or link issues are fixed.'
          : 'Ready to launch.';
      }
      // Persona statuses mirror path outcomes regardless of which verdict source ran.
      r.personas = r.personas.map((p) => {
        const path = r.paths.find((x) => x.persona === p.id);
        if (!path) return p;
        return { ...p, status: path.status === 'passed' ? 'passed' : path.status === 'failed' ? 'failed' : p.status };
      });
    });

    pushEvent(runId, { timestamp: nowIso(), title: 'Report ready', state: 'done' });
    return;
  }
}

function labelDisplay(s: string): string {
  return s || 'Email';
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function finalizeCancelled(runId: string) {
  pushEvent(runId, {
    timestamp: nowIso(),
    title: 'Run cancelled',
    detail: 'Stopped by user request.',
    state: 'fail',
  });
  updateTestRun(runId, (r) => {
    r.status = 'cancelled';
    r.finishedAt = nowIso();
    r.nextStepAt = undefined;
    r.cancelRequested = false;
  });
}

// Like sleep(ms) but wakes up periodically to honour a cancel request, so
// long "wait 30 minutes" steps don't block cancellation until they finish.
async function cancellableSleep(runId: string, ms: number): Promise<void> {
  const tick = Math.min(2000, Math.max(250, ms));
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isCancelled(runId)) throw new RunCancelledError();
    await sleep(Math.min(tick, deadline - Date.now()));
  }
}

function formatLabelTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

export function isCancelled(runId: string): boolean {
  return !!getTestRun(runId)?.cancelRequested;
}

function throwIfCancelled(runId: string) {
  if (isCancelled(runId)) throw new RunCancelledError();
}
