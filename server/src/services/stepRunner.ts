import { nanoid } from 'nanoid';
import { AgentEvent, FlowStep, Persona, QaReport, TestRun } from '../types';
import { getTestRun, updateTestRun } from './store';
import { applyLabel, ensureLabel, syncMessages } from './gmailService';
import { checkEmailLinks, performPersonaAction } from './linkChecker';
import { generateQaReport } from './geminiService';
import { validateFlow } from './flowValidator';
import { fireEntryEvent, sfmcConfigured } from './sfmcService';

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

function compressMs(run: TestRun, ms: number): number {
  const div = Math.max(1, Number(run.demoTimeCompression || 1));
  return Math.max(0, Math.round(ms / div));
}

function formatRemaining(ms: number): string {
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / (60 * 60_000)).toFixed(1)}h`;
}

export interface StepRunnerOpts {
  liveGmail: boolean; // if true, use the Gmail API for sync; if false, use in-memory demo emails
  demoInjector?: (run: TestRun, ctx: { pushEvent: (ev: Omit<AgentEvent, 'id'>) => void; markPersonaStatus: (p: Persona, s: any) => void }) => Promise<void>;
}

// Walks the run's expectedFlow.steps sequentially. Wait steps use setTimeout in real time
// (divided by run.demoTimeCompression if set). All transitions persist to the JSON store
// so the polling client sees live progress.
export async function runStepPlan(runId: string, opts: StepRunnerOpts): Promise<void> {
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

  if (opts.liveGmail) {
    const startRun = getTestRun(runId)!;
    // Nested label so Gmail sidebar shows "InboxFlow Tests" with each run as a sub-folder.
    // Format: "InboxFlow Tests/2026-05-19 03:37 — Subscription Confirmation"
    const labelName = `InboxFlow Tests/${formatLabelTimestamp(new Date())} — ${startRun.campaignName}`;
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
  }

  // Fire any vendor-specific campaign triggers (e.g. SFMC entry events) so the
  // ESP delivers the emails this run is supposed to watch for. Done before the
  // step loop so the first sync window has emails to find.
  await fireCampaignTriggers(runId);

  const fresh = getTestRun(runId)!;
  const steps = fresh.steps || [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    updateTestRun(runId, (r) => {
      r.currentStepIndex = i;
      if (r.steps) r.steps[i] = { ...r.steps[i], state: 'active', startedAt: nowIso() };
    });

    try {
      await executeStep(runId, step, opts);
      updateTestRun(runId, (r) => {
        if (r.steps) r.steps[i] = { ...r.steps[i], state: 'done', endedAt: nowIso() };
      });
    } catch (err) {
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

async function executeStep(runId: string, step: FlowStep, opts: StepRunnerOpts): Promise<void> {
  const run = getTestRun(runId);
  if (!run) return;

  if (step.kind === 'start') {
    pushEvent(runId, { timestamp: nowIso(), title: step.descr || 'Test plan created', detail: `${run.expectedFlow.totalEmails} emails parsed`, state: 'done' });
    return;
  }

  if (step.kind === 'wait') {
    const target = compressMs(run, step.durationMs || 0);
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || `Wait ${step.durationLabel || formatRemaining(target)}`,
      detail: target !== (step.durationMs || 0) ? `(compressed to ${formatRemaining(target)} for demo)` : undefined,
      state: 'active',
    });
    updateTestRun(runId, (r) => {
      r.nextStepAt = new Date(Date.now() + target).toISOString();
    });
    await sleep(target);
    updateTestRun(runId, (r) => {
      r.nextStepAt = undefined;
    });
    pushEvent(runId, { timestamp: nowIso(), title: 'Wait complete', detail: step.durationLabel, state: 'done' });
    return;
  }

  if (step.kind === 'sync') {
    pushEvent(runId, {
      timestamp: nowIso(),
      title: step.descr || 'Sync inbox',
      detail: opts.liveGmail ? `Querying ${run.seedInbox} via Gmail API` : 'Demo simulation',
      state: 'active',
    });

    if (opts.liveGmail) {
      const aliasList = run.personas.map((p) => p.alias).join(', ');
      const alreadyReceivedByPersona: Record<string, string[]> = {};
      for (const e of run.emails) {
        (alreadyReceivedByPersona[e.persona] ||= []).push(e.emailLabel);
      }
      const { emails, query, totalScanned, droppedNoPersona } = await syncMessages({
        campaignName: run.campaignName,
        seedInbox: run.seedInbox,
        personas: run.personas,
        expectedFlow: run.expectedFlow,
        alreadyReceivedByPersona,
      });
      // Merge: keep all previously-seen emails by id
      const existing = new Set(run.emails.map((e) => e.id));
      const newOnes = emails.filter((e) => !existing.has(e.id));
      let totalChecked = 0;
      let totalSkippedTracking = 0;
      let totalSkippedCta = 0;
      for (const e of newOnes) {
        const scan = await checkEmailLinks(e, false);
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
        detail: `Gmail q: ${query} · looking for aliases ${aliasList} · ${newOnes.length} new, ${droppedNoPersona} dropped`,
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
    } else if (opts.demoInjector) {
      await opts.demoInjector(run, {
        pushEvent: (ev) => pushEvent(runId, ev),
        markPersonaStatus: (p, s) => markPersonaStatus(runId, p, s),
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
    const result = await performPersonaAction(persona.id, action, target, !opts.liveGmail);
    updateTestRun(runId, (r) => r.actions.push(result));
    const verbMap: Record<string, string> = {
      clicked_primary_cta: 'Primary CTA clicked',
      no_click: 'Held back (no action)',
      opened: 'Email opened',
      replied: 'Replied',
      unsubscribed: 'Unsubscribed (recorded, not executed)',
      failed_to_click: 'CTA click failed',
    };
    pushEvent(runId, {
      timestamp: nowIso(),
      title: verbMap[result.action] || result.action,
      detail: `${persona.displayName} · ${result.url || ''}`,
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

function slugifyCampaign(name: string): string {
  return (name || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';
}

function formatLabelTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Wait this long after firing entry events for SFMC to actually deliver the
// first email. The agent must not start polling the inbox immediately — emails
// take a minute or two to flow through Journey Builder + the SMTP path.
const TRIGGER_DELIVERY_WAIT_MS = 3 * 60 * 1000; // 3 minutes

async function fireCampaignTriggers(runId: string): Promise<void> {
  const run = getTestRun(runId);
  if (!run || !run.triggers?.length) return;

  if (!sfmcConfigured() && run.triggers.some((t) => t.vendor === 'sfmc')) {
    pushEvent(runId, {
      timestamp: nowIso(),
      title: 'Skipping SFMC entry events',
      detail: 'SFMC_SUBDOMAIN / SFMC_CLIENT_ID / SFMC_CLIENT_SECRET / SFMC_ACCOUNT_ID not set in .env.',
      state: 'fail',
    });
    return;
  }

  // Fire all triggers in parallel — they're independent and SFMC handles a small burst.
  const results = await Promise.all(
    run.triggers.map(async (t) => {
      if (t.vendor !== 'sfmc') return false;
      try {
        const result = await fireEntryEvent({
          contactKey: t.contactKey,
          eventDefinitionKey: t.eventDefinitionKey,
          data: t.data,
        });
        pushEvent(runId, {
          timestamp: nowIso(),
          title: result.ok
            ? `Fired SFMC entry event for ${t.email}`
            : `SFMC entry event failed for ${t.email}`,
          detail: result.ok
            ? `ContactKey ${t.contactKey} · EventDefinitionKey ${t.eventDefinitionKey}${result.eventInstanceId ? ' · eventInstanceId ' + result.eventInstanceId : ''}`
            : result.error || 'unknown',
          state: result.ok ? 'done' : 'fail',
        });
        return result.ok;
      } catch (err) {
        pushEvent(runId, {
          timestamp: nowIso(),
          title: `SFMC entry event errored for ${t.email}`,
          detail: (err as Error).message,
          state: 'fail',
        });
        return false;
      }
    }),
  );

  // If at least one trigger fired successfully, hold off and let SFMC actually
  // deliver before the agent starts inbox polling. This is a separate wait from
  // any "wait X minutes" the journey itself contains; that's still executed by
  // the parsed step plan.
  if (results.some((ok) => ok)) {
    const target = compressMs(run, TRIGGER_DELIVERY_WAIT_MS);
    pushEvent(runId, {
      timestamp: nowIso(),
      title: 'Journey is triggered — waiting for emails to arrive',
      detail: `Holding for ${formatRemaining(target)} so SFMC can deliver. The agent will start watching the inbox after that.`,
      state: 'active',
    });
    updateTestRun(runId, (r) => {
      r.nextStepAt = new Date(Date.now() + target).toISOString();
    });
    await sleep(target);
    updateTestRun(runId, (r) => {
      r.nextStepAt = undefined;
    });
    pushEvent(runId, {
      timestamp: nowIso(),
      title: 'Delivery window elapsed',
      detail: 'Now watching the inbox for captured emails.',
      state: 'done',
    });
  }
}
