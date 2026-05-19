import { Router } from 'express';
import { nanoid } from 'nanoid';
import { listTestRuns, getTestRun, saveTestRun, updateTestRun } from '../services/store';
import { parseExpectedFlowAndName } from '../services/geminiService';
import { runStepPlan } from '../services/stepRunner';
import { injectDemoEmails } from '../services/demoSimulator';
import { gmailConfigured, syncMessages } from '../services/gmailService';
import { DEMO_PRESETS, isDemoCampaignKey } from '../services/demoPresets';
import { TestRun, TestRunReport, RunStatus, PersonaConfig } from '../types';

export const testRunsRouter = Router();

// Seed inbox is hardcoded — all SFMC test emails land here regardless of env.
const FIXED_SEED_INBOX = 'sfmctest950@gmail.com';

testRunsRouter.get('/', (_req, res) => {
  res.json(listTestRuns());
});

testRunsRouter.get('/:id', (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  res.json(run);
});

testRunsRouter.post('/', async (req, res) => {
  const body = req.body || {};
  const demoCampaign: string | undefined = body.demoCampaign;
  const demoPreset = demoCampaign && isDemoCampaignKey(demoCampaign) ? DEMO_PRESETS[demoCampaign] : undefined;

  // If a demoCampaign is specified, use the preset's canonical prompt verbatim.
  // Otherwise the user provided a free-form prompt.
  const expectedFlowText: string = demoPreset ? demoPreset.prompt : (body.expectedFlowText || '');
  const demoTimeCompression = Math.max(1, Number(body.demoTimeCompression || 1));

  if (!expectedFlowText.trim()) {
    return res.status(400).json({ error: 'missing_prompt', message: 'expectedFlowText is required' });
  }

  const { flow: expectedFlow, campaignName } = await parseExpectedFlowAndName(expectedFlowText);
  const personas: PersonaConfig[] = (expectedFlow.personas || []).map((p) => ({ ...p, status: 'waiting' }));

  const id = 'run_' + nanoid(6);
  const run: TestRun = {
    id,
    campaignName,
    seedInbox: FIXED_SEED_INBOX,
    expectedFlowText,
    expectedFlow,
    personas,
    triggers: demoPreset?.triggers,
    status: 'draft',
    createdAt: new Date().toISOString(),
    events: [],
    emails: [],
    actions: [],
    findings: [],
    paths: [],
    steps: expectedFlow.steps?.map((s) => ({ ...s, state: 'pending' })),
    demoTimeCompression,
  };
  saveTestRun(run);
  res.json(run);
});

testRunsRouter.post('/:id/start', async (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  const mode = (process.env.APP_MODE || 'demo').toLowerCase();
  const useLiveGmail = mode === 'live' && gmailConfigured();

  runStepPlan(run.id, {
    liveGmail: useLiveGmail,
    demoInjector: useLiveGmail ? undefined : injectDemoEmails,
  }).catch((err) => {
    console.error('[runStepPlan] failed', err);
    updateTestRun(run.id, (r) => {
      r.status = 'failed';
      r.finishedAt = new Date().toISOString();
      r.events.push({
        id: 'e_' + nanoid(8),
        timestamp: new Date().toISOString(),
        title: 'Run failed',
        detail: (err as Error).message,
        state: 'fail',
      });
    });
  });

  res.json({ ok: true, mode: useLiveGmail ? 'live' : 'demo', runId: run.id });
});

testRunsRouter.get('/:id/events', (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  res.json(run.events);
});

function buildReport(run: TestRun): TestRunReport {
  const blockers = run.findings.filter((f) => f.severity === 'blocker').length;
  const warnings = run.findings.filter((f) => f.severity === 'warning').length;
  const status: RunStatus = run.status;
  return {
    campaignName: run.campaignName,
    testRunId: run.id,
    createdAt: run.createdAt,
    overall: status,
    recommendation:
      run.recommendation ||
      (status === 'failed'
        ? 'Do not launch until the flagged issues are resolved.'
        : 'Ready to launch.'),
    summary: {
      emailsExpected: run.expectedFlow.totalEmails,
      emailsReceived: run.emails.length,
      pathsTested: run.paths.length || run.expectedFlow.branches.length,
      blockers,
      warnings,
    },
    paths: run.paths,
    findings: run.findings,
    events: run.events,
    emails: run.emails,
    personas: run.personas,
    expectedFlow: run.expectedFlow,
    qaReport: run.qaReport,
  };
}

testRunsRouter.get('/:id/report', (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  res.json(buildReport(run));
});

function statusMark(s: 'pass' | 'fail' | 'warn'): string {
  if (s === 'pass') return '✅ Passed';
  if (s === 'fail') return '❌ Failed';
  return '⚠️ Warning';
}

function mdEscape(s: string): string {
  return (s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function proofLine(proofs?: { kind: string; subject?: string; url?: string; receivedAt?: string; note?: string; gmailUrl?: string }[]): string {
  if (!proofs || !proofs.length) return '';
  const bits: string[] = [];
  for (const p of proofs) {
    if (p.kind === 'email' && (p.subject || p.gmailUrl)) {
      const lbl = p.subject ? `"${p.subject}"` : 'email';
      bits.push(p.gmailUrl ? `[${lbl}](${p.gmailUrl})` : lbl);
    } else if (p.kind === 'link' && p.url) {
      bits.push(p.url);
    } else if (p.note) {
      bits.push(p.note);
    } else if (p.receivedAt) {
      bits.push(p.receivedAt);
    }
  }
  return bits.length ? ` _(proof: ${bits.join(' · ')})_` : '';
}

function toMarkdown(r: TestRunReport): string {
  const q = r.qaReport;
  const lines: string[] = [];
  const result = q?.result || (r.overall === 'failed' ? 'failed' : 'passed');
  const resultMark = result === 'failed' ? '❌ Failed' : '✅ Passed';
  const recommendation = q?.recommendation || (result === 'failed' ? 'Do not launch' : 'Ready to launch');
  const readiness = q?.readiness;

  lines.push(`# InboxFlow Test Report`);
  lines.push('');
  lines.push(`**Run:** ${r.testRunId}  `);
  lines.push(`**Campaign:** ${r.campaignName}  `);
  lines.push(`**Result:** ${resultMark}  `);
  lines.push(`**Recommendation:** ${recommendation}`);
  lines.push('');

  // Campaign readiness block
  if (readiness) {
    lines.push('## Campaign readiness');
    lines.push('');
    lines.push(`- **Decision:** ${readiness.decision}`);
    if (readiness.topFixes.length) {
      lines.push(`- **Top fixes:**`);
      for (const f of readiness.topFixes) lines.push(`  - ${f}`);
    }
    lines.push(`- **Re-test required:** ${readiness.retestRequired ? 'Yes' : 'No'}`);
    lines.push('');
  }

  // Persona Replay
  const replay = q?.replay || [];
  if (replay.length) {
    lines.push('## Persona replay');
    lines.push('');
    for (const r of replay) {
      const chain = r.steps.map((s) => s.label).join(' → ');
      const outcome = r.outcome === 'passed' ? '✅ passed' : r.outcome === 'failed' ? '❌ failed' : '⚠️ partial';
      lines.push(`- **${r.personaName}:** ${chain} — ${outcome}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // 1. Flow
  lines.push(`## 1. Flow`);
  lines.push('');
  lines.push(`| Check | Expected | Actual | Status | Fix |`);
  lines.push(`|---|---|---|---|---|`);
  const flowChecks = q?.flowChecks || [];
  if (!flowChecks.length) {
    lines.push(`| — | — | — | — | — |`);
  } else {
    for (const fc of flowChecks) {
      const fixWithProof = (mdEscape(fc.fix) || '—') + (fc.status !== 'pass' ? proofLine(fc.proofs) : '');
      lines.push(
        `| ${mdEscape(fc.name)} | ${mdEscape(fc.expected)} | ${mdEscape(fc.actual)} | ${statusMark(fc.status)} | ${fixWithProof} |`,
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // 2. Content & Links
  lines.push(`## 2. Content & Links`);
  lines.push('');
  const emails = q?.emails || [];
  if (!emails.length) {
    lines.push(`_No emails were captured during this run._`);
  } else {
    for (const er of emails) {
      const header = er.gmailUrl ? `### ${er.emailLabel} — ${er.personaDisplay} ([open in Gmail](${er.gmailUrl}))` : `### ${er.emailLabel} — ${er.personaDisplay}`;
      lines.push(header);
      lines.push('');
      lines.push(`| Check | Status | Finding | Fix |`);
      lines.push(`|---|---|---|---|`);
      for (const c of er.checks) {
        const finding = c.status === 'pass' ? '—' : mdEscape(c.finding) || '—';
        const fix = c.status === 'pass' ? '—' : (mdEscape(c.fix) || '—') + proofLine(c.proofs);
        lines.push(`| ${mdEscape(c.name)} | ${statusMark(c.status)} | ${finding} | ${fix} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

testRunsRouter.post('/:id/export', (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  const format = String(req.query.format || req.body?.format || 'json').toLowerCase();
  const report = buildReport(run);
  if (format === 'markdown' || format === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${run.id}-report.md"`);
    return res.send(toMarkdown(report));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${run.id}-report.json"`);
  return res.send(JSON.stringify(report, null, 2));
});

testRunsRouter.post('/:id/sync-gmail', async (req, res) => {
  const run = getTestRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  if (!gmailConfigured()) return res.status(400).json({ error: 'gmail_not_configured' });
  try {
    const { emails } = await syncMessages({
      campaignName: run.campaignName,
      seedInbox: run.seedInbox,
      personas: run.personas,
    });
    updateTestRun(run.id, (r) => {
      r.emails = emails;
    });
    res.json({ ok: true, count: emails.length });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: (err as Error).message });
  }
});
