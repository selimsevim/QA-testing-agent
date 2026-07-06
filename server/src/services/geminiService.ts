import {
  BehaviorAction,
  ContentCheck,
  EmailContentReport,
  ExpectedFlow,
  FlowCheck,
  FlowStep,
  ParsedEmail,
  PathResult,
  PersonaAction,
  PersonaConfig,
  PersonaReplay,
  Proof,
  QaReport,
  ReadinessSummary,
  ReplayStep,
} from '../types';
import { nanoid } from 'nanoid';
import { fetchPageContent, PageFetchResult } from './linkChecker';

function gmailMessageUrl(emailId: string | undefined): string | undefined {
  if (!emailId) return undefined;
  // Deep-link to the message in Gmail (works whether the email lives in Inbox or a label).
  return `https://mail.google.com/mail/u/0/#all/${emailId}`;
}

function emailProof(e: ParsedEmail | undefined): Proof | undefined {
  if (!e) return undefined;
  return {
    kind: 'email',
    emailId: e.id,
    threadId: e.threadId,
    gmailUrl: gmailMessageUrl(e.id),
    subject: e.subject,
    to: e.to,
    receivedAt: e.date,
    snippet: (e.textBody || '').slice(0, 120),
  };
}

let cachedKey: string | undefined;
function getKey(): string | undefined {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = process.env.GEMINI_API_KEY || '';
  return cachedKey;
}

export function geminiConfigured(): boolean {
  return !!getKey();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/__+/g, '_');
}

function tryParseJson<T>(text: string): T | null {
  try {
    const stripped = text
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();
    return JSON.parse(stripped) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// --- Deterministic persona inference (fallback when Gemini is off or fails) ---

interface PersonaSeed {
  id: string;
  displayName: string;
  behaviorAction: BehaviorAction;
  behavior: string;
}

function inferPersonasFromText(text: string): PersonaSeed[] {
  const lower = text.toLowerCase();
  const seeds: PersonaSeed[] = [];
  const has = (...ks: string[]) => ks.some((k) => lower.includes(k));

  // Click engagement
  if (has('click') || has('cta')) {
    seeds.push({ id: 'clicker', displayName: 'Clicker', behaviorAction: 'click_primary_cta', behavior: 'Clicks the primary CTA' });
    if (has('not click', "don't click", 'do not click', 'no click', 'no-click', "doesn't click")) {
      seeds.push({ id: 'non_clicker', displayName: 'Non-clicker', behaviorAction: 'no_action', behavior: 'Does not click any CTA' });
    }
  }
  // Open engagement
  if (has('open')) {
    seeds.push({ id: 'opener', displayName: 'Opener', behaviorAction: 'open_only', behavior: 'Opens the email but does not click' });
    if (has('not open', 'no open', 'no-open', 'unopened')) {
      seeds.push({ id: 'non_opener', displayName: 'Non-opener', behaviorAction: 'no_action', behavior: 'Does not open the email' });
    }
  }
  // Reply engagement
  if (has('reply', 'replies')) {
    seeds.push({ id: 'replier', displayName: 'Replier', behaviorAction: 'reply', behavior: 'Replies to the email' });
  }
  // Unsubscribe
  if (has('unsubscribe', 'opt out', 'opt-out')) {
    seeds.push({ id: 'unsubscriber', displayName: 'Unsubscriber', behaviorAction: 'unsubscribe', behavior: 'Unsubscribes after first email' });
  }

  if (seeds.length === 0) {
    // Last-ditch default: clicker / non_clicker keeps the agent useful
    seeds.push(
      { id: 'clicker', displayName: 'Clicker', behaviorAction: 'click_primary_cta', behavior: 'Clicks the primary CTA' },
      { id: 'non_clicker', displayName: 'Non-clicker', behaviorAction: 'no_action', behavior: 'Does not click any CTA' },
    );
  }
  // De-dupe
  const seen = new Set<string>();
  return seeds.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

function stepId() {
  return 's_' + nanoid(6);
}

function parseDurationToMs(input: string): { ms: number; label: string } | null {
  const m = input.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  let ms = 0;
  if (/^(s|sec|secs|second|seconds)$/.test(unit)) ms = n * 1000;
  else if (/^(m|min|mins|minute|minutes)$/.test(unit)) ms = n * 60 * 1000;
  else if (/^(h|hr|hrs|hour|hours)$/.test(unit)) ms = n * 60 * 60 * 1000;
  else if (/^(d|day|days)$/.test(unit)) ms = n * 24 * 60 * 60 * 1000;
  if (!ms) return null;
  return { ms, label: `${n} ${unit}${n === 1 ? '' : unit.endsWith('s') ? '' : 's'}` };
}

function extractDurations(text: string): { ms: number; label: string; index: number }[] {
  const out: { ms: number; label: string; index: number }[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parsed = parseDurationToMs(m[0]);
    if (parsed) out.push({ ...parsed, index: m.index });
  }
  return out;
}

function deterministicFlow(text: string): ExpectedFlow {
  const totalMatch = text.match(/(\d+)\s+emails?/i);
  const totalEmails = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const entryTrigger =
    /form/i.test(text) ? 'form_submit'
    : /sign\s*up/i.test(text) ? 'signup'
    : /purchase|order/i.test(text) ? 'purchase'
    : /trigger/i.test(text) ? 'trigger'
    : 'unspecified';

  const seeds = inferPersonasFromText(text);
  const personas: PersonaConfig[] = seeds.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    alias: `+${s.id.replace(/_/g, '')}`,
    behavior: s.behavior,
    behaviorAction: s.behaviorAction,
    status: 'waiting',
  }));

  // Branches: extract email labels mentioned in the text, then guess per-persona expected sequences.
  const labels = Array.from(text.matchAll(/(Email\s*\d+[A-Z]?|Reminder\s*\d+[A-Z]?|Final\s+Email\s*\d+|Welcome\s+Email|Confirmation)/gi))
    .map((m) => m[0].replace(/\s+/g, ' ').trim());
  const uniqLabels: string[] = [];
  for (const l of labels) {
    if (!uniqLabels.find((u) => u.toLowerCase() === l.toLowerCase())) uniqLabels.push(l);
  }

  const has2A = uniqLabels.find((l) => /2a$/i.test(l));
  const has2B = uniqLabels.find((l) => /2b$/i.test(l));
  const hasFinal = uniqLabels.find((l) => /final/i.test(l));

  const branches = personas.map((p) => {
    const expected: string[] = [];
    if (uniqLabels[0]) expected.push(uniqLabels[0]);
    if (p.behaviorAction === 'click_primary_cta' && has2A) expected.push(has2A);
    else if (p.behaviorAction === 'no_action' && has2B) expected.push(has2B);
    else if (uniqLabels[1]) expected.push(uniqLabels[1]);
    if (hasFinal) expected.push(hasFinal);
    return { personaId: p.id, expected: expected.length ? expected : uniqLabels };
  });

  // Build a minimal default step plan. Real timing comes from text via extractDurations.
  const durations = extractDurations(text);
  const steps: FlowStep[] = [
    { id: stepId(), kind: 'start', descr: 'Test plan created' },
    { id: stepId(), kind: 'sync', descr: 'Sync inbox: first email arrival' },
  ];
  const actorPersona = personas.find((p) => p.behaviorAction !== 'no_action');
  if (actorPersona) {
    // Optional pre-action wait (first duration mentioned in text)
    if (durations[0]) {
      steps.push({
        id: stepId(),
        kind: 'wait',
        descr: `Wait ${durations[0].label} before ${actorPersona.displayName} acts`,
        durationMs: durations[0].ms,
        durationLabel: durations[0].label,
      });
    }
    steps.push({
      id: stepId(),
      kind: 'action',
      descr: `${actorPersona.displayName}: ${actorPersona.behavior}`,
      personaId: actorPersona.id,
      action: actorPersona.behaviorAction,
    });
    // Post-action wait + sync
    if (durations[1] || durations[0]) {
      const d = durations[1] || durations[0];
      steps.push({
        id: stepId(),
        kind: 'wait',
        descr: `Wait ${d.label} for follow-up`,
        durationMs: d.ms,
        durationLabel: d.label,
      });
    }
    steps.push({ id: stepId(), kind: 'sync', descr: 'Sync inbox: follow-up emails' });
  }
  steps.push({ id: stepId(), kind: 'validate', descr: 'Flow validation' });
  steps.push({ id: stepId(), kind: 'report', descr: 'Generate launch-readiness report' });

  return {
    totalEmails: totalEmails || uniqLabels.length || personas.length + 1,
    entryTrigger,
    personas,
    branches,
    steps,
  };
}

// Call options:
//   fast:     use gemini-2.5-flash instead of the env default (typically gemini-2.5-pro).
//   thinking: keep Gemini 2.5's reasoning pass on (default) for semantic checks where
//             quality matters. Pass false for simple structured JSON output (label
//             classification, flow parsing schema, campaign-name derivation) — saves
//             several seconds per call.
async function callGemini(
  prompt: string,
  opts: { fast?: boolean; thinking?: boolean } = {},
): Promise<string | null> {
  const key = getKey();
  if (!key) return null;
  const primary = opts.fast ? 'gemini-2.5-flash' : (process.env.GEMINI_MODEL || 'gemini-2.5-pro');
  const fallback = 'gemini-2.5-flash';
  const useThinking = opts.thinking !== false;
  const tryModel = async (name: string): Promise<string | null> => {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const ai = new GoogleGenerativeAI(key);
    const generationConfig: any = {
      responseMimeType: 'application/json',
      temperature: 0.2,
    };
    if (!useThinking) {
      // Gemini 2.5 family supports thinkingBudget. 0 = no reasoning pass.
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const model = ai.getGenerativeModel({ model: name, generationConfig });
    const result = await model.generateContent(prompt);
    return result.response.text();
  };
  try {
    return await tryModel(primary);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('404') && primary !== fallback) {
      console.warn(`[gemini] ${primary} unavailable, retrying with ${fallback}`);
      try {
        return await tryModel(fallback);
      } catch (err2) {
        console.warn('[gemini] fallback model also failed:', (err2 as Error).message);
        return null;
      }
    }
    console.warn('[gemini] call failed, falling back to deterministic:', msg);
    return null;
  }
}

// In-memory cache of parsed flows + derived names. Keyed by trimmed prompt text.
// Cleared whenever the server restarts. Same prompt → instant re-test.
const parseCache = new Map<string, { flow: ExpectedFlow; campaignName: string }>();
const MAX_CACHE = 50;

function getCachedParse(text: string): { flow: ExpectedFlow; campaignName: string } | undefined {
  const key = text.trim();
  const hit = parseCache.get(key);
  if (!hit) return undefined;
  // LRU-ish: re-set to bump recency.
  parseCache.delete(key);
  parseCache.set(key, hit);
  return hit;
}

function setCachedParse(text: string, value: { flow: ExpectedFlow; campaignName: string }) {
  const key = text.trim();
  parseCache.set(key, value);
  while (parseCache.size > MAX_CACHE) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    parseCache.delete(oldest);
  }
}

// New combined call: parse the flow AND derive a campaign name in one Gemini round-trip.
export async function parseExpectedFlowAndName(text: string): Promise<{ flow: ExpectedFlow; campaignName: string }> {
  const cached = getCachedParse(text);
  if (cached) return cached;

  const flow = await parseExpectedFlow(text);
  // parseExpectedFlow already calls Gemini; we'll piggyback the name request by reading
  // it from a known location on the flow if Gemini included it, else fall back.
  const fromFlow = (flow as any).campaignName as string | undefined;
  const campaignName =
    (fromFlow && String(fromFlow).trim()) ||
    (await deriveCampaignName(text));

  const out = { flow, campaignName };
  setCachedParse(text, out);
  return out;
}

export async function parseExpectedFlow(text: string): Promise<ExpectedFlow> {
  if (!geminiConfigured()) return normalizeFlow(deterministicFlow(text), text);
  const prompt = `You are an email marketing QA agent. Read the campaign description below and produce a structured, executable test plan.

Return ONLY JSON (no markdown). Schema:
{
  "campaignName": string,
  "totalEmails": number,
  "entryTrigger": string,
  "personas": [
    {
      "id": string,                            // snake_case slug derived from the user's text (e.g. "clicker", "non_clicker", "opener", "replier", "unsubscriber")
      "displayName": string,
      "alias": string,                         // "+<slug without underscores>", e.g. "+clicker", "+nonclicker"
      "behavior": string,
      "behaviorAction": "click_primary_cta" | "no_action" | "open_only" | "reply" | "unsubscribe" | "submit_form" | "custom"
    }
  ],
  "branches": [
    { "personaId": string, "expected": string[] }
  ],
  "steps": [
    { "kind": "start",    "descr": string },
    { "kind": "sync",     "descr": string, "expectedLabel": string, "expectedPersonas": string[] },
    { "kind": "wait",     "descr": string, "durationMs": number, "durationLabel": string },
    { "kind": "action",   "descr": string, "personaId": string, "action": "click_primary_cta" | "no_action" | "open_only" | "reply" | "unsubscribe" },
    { "kind": "validate", "descr": string },
    { "kind": "report",   "descr": string }
  ]
}

campaignName must be a short 3-6 word title for this test (Title Case, no quotes, no trailing period). Examples: "Subscription Confirmation Flow", "Welcome Series with Reminder".

CRITICAL RULES for steps and timing:
- Infer EVERY wait period from the user's text. If they wrote "wait 10 minutes after click", emit a "wait" step with durationMs = 600000 and durationLabel = "10 minutes".
- Time expressions can use seconds / minutes / hours / days. Convert them all to durationMs.
- Order the steps in execution order: start → sync → [wait → action → wait → sync]* → validate → report.
- Persona aliases MUST be "+<id without underscores>" so the agent can detect them by substring in any recipient header.
- Personas come strictly from the text — do not invent.
- For "wait" step descriptions: describe what we are waiting FOR, not what the persona is not doing. Good: "Wait 2 minutes for the reminder email to send". "Wait 10 minutes for the follow-up to arrive". Bad: "Wait 2 minutes for the alias to not click", "Wait 5 minutes for non-clicker behavior". Phrase positively — name the next expected event (a specific email, a sync, an action) the wait window is allowing for.

RULES for email labels in "branches[].expected":
- Use the same wording the user used. If they wrote "welcome email", the label is "Welcome email". If they wrote "Email 2A", the label is "Email 2A".
- Never invent generic "Email 1" / "Email 2" labels when the user described the email by purpose (welcome, confirmation, reminder, thank-you, etc.). Capitalize Sentence case.
- Each label should be 1-4 words. Strip articles ("the welcome email" → "Welcome email").
- Labels should be unique per branch and stable across personas (both branches' first label is the same if they share Email 1).

Description:
"""${text}"""`;

  const raw = await callGemini(prompt, { fast: true, thinking: false });
  if (!raw) return normalizeFlow(deterministicFlow(text), text);
  const parsed = tryParseJson<ExpectedFlow>(raw);
  if (!parsed || !Array.isArray(parsed.personas) || !Array.isArray(parsed.branches)) {
    return normalizeFlow(deterministicFlow(text), text);
  }
  return normalizeFlow(parsed, text);
}

function normalizeFlow(flow: ExpectedFlow, originalText: string): ExpectedFlow {
  // Make sure every persona has alias + behaviorAction + status, and that branches reference real persona ids.
  const personas: PersonaConfig[] = (flow.personas || []).map((p) => {
    const id = slugify(p.id || p.displayName || 'persona');
    const alias = (p.alias && p.alias.startsWith('+') ? p.alias : `+${id.replace(/_/g, '')}`).toLowerCase();
    const behaviorAction: BehaviorAction = (p.behaviorAction as BehaviorAction) || 'custom';
    return {
      id,
      displayName: p.displayName || (id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ')),
      alias,
      behavior: p.behavior || (behaviorAction === 'no_action' ? 'Does not act' : 'Performs the configured action'),
      behaviorAction,
      status: 'waiting',
    };
  });
  if (personas.length === 0) {
    return normalizeFlow(deterministicFlow(originalText), originalText);
  }
  const personaIds = new Set(personas.map((p) => p.id));
  const branches = (flow.branches || [])
    .map((b) => ({
      personaId: slugify((b as any).personaId || (b as any).persona || ''),
      expected: Array.isArray(b.expected) ? b.expected.filter(Boolean).map(String) : [],
    }))
    .filter((b) => personaIds.has(b.personaId));
  // Backfill any missing branch
  for (const p of personas) {
    if (!branches.find((b) => b.personaId === p.id)) {
      branches.push({ personaId: p.id, expected: [] });
    }
  }
  // Normalize steps
  let steps: FlowStep[] = Array.isArray((flow as any).steps) ? ((flow as any).steps as any[]) : [];
  steps = steps.map((s) => {
    let durationMs: number | undefined = typeof s.durationMs === 'number' && s.durationMs > 0 ? s.durationMs : undefined;
    let durationLabel: string | undefined = s.durationLabel || undefined;
    // Reconcile descr text with durationMs/durationLabel — Gemini sometimes writes
    // "Wait 5 minutes…" in descr but emits durationMs = 240000 (4 min). Re-parse
    // the descr for a duration; if it disagrees with durationMs, trust the descr.
    const descr = String(s.descr || s.kind || '');
    if ((s.kind === 'wait' || s.kind === undefined) && descr) {
      const fromDescr = parseDurationToMs(descr);
      if (fromDescr) {
        if (!durationMs || Math.abs(durationMs - fromDescr.ms) > 500) {
          durationMs = fromDescr.ms;
          durationLabel = fromDescr.label;
        }
      }
    }
    return {
      id: s.id || stepId(),
      kind: (s.kind as any) || 'start',
      descr,
      durationMs,
      durationLabel,
      expectedLabel: s.expectedLabel || undefined,
      expectedPersonas: Array.isArray(s.expectedPersonas) ? s.expectedPersonas.map(slugify).filter(Boolean) : undefined,
      personaId: s.personaId ? slugify(s.personaId) : undefined,
      action: s.action || undefined,
      state: 'pending' as const,
    };
  });
  // Ensure we at least bookend with start / validate / report.
  if (!steps.find((s) => s.kind === 'start')) steps.unshift({ id: stepId(), kind: 'start', descr: 'Test plan created', state: 'pending' });
  if (!steps.find((s) => s.kind === 'validate')) steps.push({ id: stepId(), kind: 'validate', descr: 'Flow validation', state: 'pending' });
  if (!steps.find((s) => s.kind === 'report')) steps.push({ id: stepId(), kind: 'report', descr: 'Generate launch-readiness report', state: 'pending' });

  const out: ExpectedFlow & { campaignName?: string } = {
    totalEmails: Number(flow.totalEmails) || branches.reduce((m, b) => Math.max(m, b.expected.length), 0),
    entryTrigger: flow.entryTrigger || 'unspecified',
    personas,
    branches,
    steps,
  };
  const candidateName = (flow as any).campaignName;
  if (typeof candidateName === 'string' && candidateName.trim()) {
    out.campaignName = candidateName.trim().slice(0, 80);
  }
  return out;
}

export interface ContentAnalysis {
  contentConsistencyStatus: 'pass' | 'warning' | 'fail';
  issues: Array<{
    severity: 'warning' | 'blocker';
    category: 'Content consistency';
    finding: string;
    suggestedFix: string;
  }>;
}

function deterministicContentAnalysis(email: ParsedEmail, campaignName: string): ContentAnalysis {
  const issues: ContentAnalysis['issues'] = [];
  const ctaText = (email.primaryCta?.text || '').toLowerCase();
  const ctaUrl = (email.primaryCta?.url || '').toLowerCase();
  if (
    ctaText &&
    !ctaUrl.includes(ctaText.replace(/\s+/g, '-')) &&
    !ctaUrl.includes('offer') &&
    !ctaUrl.includes('campaign')
  ) {
    issues.push({
      severity: 'warning',
      category: 'Content consistency',
      finding: 'CTA destination does not clearly match campaign intent',
      suggestedFix: 'Align CTA copy, landing page, and campaign objective',
    });
  }
  return { contentConsistencyStatus: issues.length ? 'warning' : 'pass', issues };
}

export async function analyzeContent(
  email: ParsedEmail,
  campaignName: string,
  expectedFlowText: string,
): Promise<ContentAnalysis> {
  if (!geminiConfigured()) return deterministicContentAnalysis(email, campaignName);
  const prompt = `You are an email marketing QA agent. Analyze this email for content consistency and campaign intent. Return ONLY JSON. No markdown.

Schema:
{
  "contentConsistencyStatus": "pass" | "warning" | "fail",
  "issues": [
    { "severity": "warning" | "blocker", "category": "Content consistency", "finding": string, "suggestedFix": string }
  ]
}

Campaign name: ${campaignName}
Expected flow: ${expectedFlowText}

Email subject: ${email.subject}
Email body (truncated): ${(email.textBody || '').slice(0, 1500)}
Primary CTA text: ${email.primaryCta?.text || ''}
Primary CTA URL: ${email.primaryCta?.url || ''}`;
  const raw = await callGemini(prompt, { fast: true });
  if (!raw) return deterministicContentAnalysis(email, campaignName);
  const parsed = tryParseJson<ContentAnalysis>(raw);
  if (!parsed || !Array.isArray(parsed.issues)) return deterministicContentAnalysis(email, campaignName);
  return parsed;
}

// ---- Email-label classification ----

export async function classifyEmailLabel(opts: {
  subject: string;
  snippet: string;
  candidates: string[];
}): Promise<string | null> {
  if (!geminiConfigured()) return null;
  const { subject, snippet, candidates } = opts;
  if (!candidates.length) return null;
  const prompt = `Classify a received email against a list of expected email labels from a marketing flow.

Return ONLY JSON: { "label": "<one of the candidates exactly, or null if none fits>" }.

Pick by semantic intent. A reminder/follow-up subject ("Did you forget...", "Still time to...", "We miss you") maps to the reminder/follow-up label. A confirmation/verification subject maps to the confirmation label. A welcome subject maps to the welcome label. A thank-you / completion subject maps to the final label.

Candidate labels (pick exactly one of these or null):
${JSON.stringify(candidates)}

Email subject: ${JSON.stringify(subject)}
Email snippet (first ~200 chars): ${JSON.stringify((snippet || '').slice(0, 200))}`;
  try {
    const raw = await callGemini(prompt, { fast: true, thinking: false });
    if (!raw) return null;
    const parsed = tryParseJson<{ label?: string | null }>(raw);
    const label = parsed?.label;
    if (typeof label === 'string' && candidates.includes(label)) return label;
    return null;
  } catch {
    return null;
  }
}

// ---- Campaign name + narrative report generation ----

export async function deriveCampaignName(text: string): Promise<string> {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'Untitled campaign';
  if (!geminiConfigured()) return deterministicCampaignName(trimmed);
  const prompt = `Read this email-marketing flow description and return a short title (3-6 words, no quotes, no trailing period). Return ONLY JSON: { "name": "..." }.

Description:
"""${trimmed}"""`;
  try {
    const raw = await callGemini(prompt, { fast: true, thinking: false });
    if (raw) {
      const parsed = tryParseJson<{ name?: string }>(raw);
      const name = (parsed?.name || '').trim();
      if (name) return name.replace(/^["']|["']$/g, '').slice(0, 80);
    }
  } catch {}
  return deterministicCampaignName(trimmed);
}

function deterministicCampaignName(text: string): string {
  const lower = text.toLowerCase();
  const cues = [
    ['form', 'Form-triggered journey'],
    ['cart', 'Cart abandonment flow'],
    ['onboard', 'Onboarding sequence'],
    ['welcome', 'Welcome series'],
    ['drip', 'Drip nurture'],
    ['re-engage', 'Re-engagement flow'],
    ['reengage', 'Re-engagement flow'],
    ['purchase', 'Post-purchase series'],
    ['order', 'Post-purchase series'],
    ['trial', 'Trial nurture'],
    ['unsubscribe', 'Unsubscribe handling'],
  ] as const;
  for (const [k, name] of cues) if (lower.includes(k)) return name;
  const m = text.match(/\d+\s*emails?/i);
  return m ? `${m[0]} sequence` : 'Lifecycle campaign';
}

interface QaReportInput {
  run: {
    campaignName: string;
    expectedFlowText: string;
    expectedFlow: ExpectedFlow;
  };
  paths: PathResult[];
  emails: ParsedEmail[];
  actions: PersonaAction[];
}

async function buildFlowChecks(input: QaReportInput): Promise<FlowCheck[]> {
  const { run, paths, emails } = input;
  const personaName = (id: string) => run.expectedFlow.personas.find((p) => p.id === id)?.displayName || id;

  // Reason about every failed path in parallel so the fix text comes from the
  // user's actual prompt, not a hardcoded template.
  return Promise.all(
    paths.map(async (p) => {
      const expected = p.expected.join(' → ') || '—';
      const actual = p.actual.join(' → ') || 'Not received';
      const proofs: Proof[] = [];
      const actualSet = new Set(p.actual);
      const expectedSet = new Set(p.expected);
      const missing = p.expected.filter((e) => !actualSet.has(e));
      const wrong = p.actual.filter((a) => !expectedSet.has(a));
      let fix = '';

      if (p.status === 'failed') {
        // Proof: the wrong-branch email(s) — show subject + Gmail link
        for (const wrongLabel of wrong) {
          const wrongEmail = emails.find((e) => e.persona === p.persona && e.emailLabel === wrongLabel);
          const ep = emailProof(wrongEmail);
          if (ep) proofs.push(ep);
          else
            proofs.push({
              kind: 'note',
              note: `Persona ${personaName(p.persona)} received "${wrongLabel}" which was reserved for another branch.`,
            });
        }
        for (const m of missing.slice(0, 2)) {
          proofs.push({
            kind: 'note',
            note: `No "${m}" arrived for ${personaName(p.persona)} during the test window.`,
          });
        }

        // Agent-phrased fix grounded in the user's actual flow description.
        try {
          fix = await reasonOverFlowFix({
            flowText: run.expectedFlowText,
            personaName: personaName(p.persona),
            expected: p.expected,
            actual: p.actual,
            missing,
            wrong,
          });
        } catch {
          fix = '';
        }
      } else if (p.status === 'passed') {
        for (const lbl of p.actual.slice(0, 3)) {
          const ok = emails.find((e) => e.persona === p.persona && e.emailLabel === lbl);
          const ep = emailProof(ok);
          if (ep) proofs.push(ep);
        }
      }
      return {
        name: `${personaName(p.persona)} path`,
        expected,
        actual,
        status: p.status === 'passed' ? 'pass' : p.status === 'failed' ? 'fail' : 'warn',
        fix,
        proofs: proofs.length ? proofs : undefined,
      };
    }),
  );
}

// Agent-driven phrasing for a failed flow path. Returns a short (<= 14 word) fix
// in plain marketer language, grounded in the user's actual prompt — no hardcoded
// "Check reminder/follow-up step" style strings that assume a particular flow.
async function reasonOverFlowFix(opts: {
  flowText: string;
  personaName: string;
  expected: string[];
  actual: string[];
  missing: string[];
  wrong: string[];
}): Promise<string> {
  if (!geminiConfigured()) return '';
  const prompt = `You are an email-marketing QA agent. A persona's path through the flow failed. Read the flow the marketer described and the per-persona delivery evidence, then write a short, concrete fix recommendation IN PLAIN LANGUAGE.

Return ONLY JSON: { "fix": "<short fix, ≤ 14 words>" }

Rules:
- NEVER invent steps that aren't in the flow. If the flow has no reminder, never say "check reminder".
- Phrase the fix using terms from the actual flow text (e.g. if the flow is a language split, talk about audience filtering / routing by language).
- No technical jargon. No HTTP status codes. No "verify journey configuration"-style filler.
- One sentence, no period.

Flow described by the marketer:
"""${opts.flowText}"""

Persona: ${opts.personaName}
Expected sequence: ${JSON.stringify(opts.expected)}
Actual sequence received: ${JSON.stringify(opts.actual)}
Labels expected but missing: ${JSON.stringify(opts.missing)}
Labels received that weren't expected: ${JSON.stringify(opts.wrong)}`;

  try {
    const raw = await callGemini(prompt, { fast: true, thinking: false });
    if (!raw) return '';
    const parsed = tryParseJson<{ fix?: string }>(raw);
    const fix = (parsed?.fix || '').trim();
    return fix.slice(0, 140);
  } catch {
    return '';
  }
}

// Render-visible body: strip <style>, <script>, then drop anchor TAGS but keep their inner
// text (so what we send Gemini matches what a reader actually sees). URLs that live only
// inside href="..." attributes are gone. Plain-text MIME parts are ignored — recipients
// view HTML, not the plain alternative.
function visibleHtmlText(email: ParsedEmail): string {
  const html = email.htmlBody || '';
  if (!html) return email.textBody || '';
  return html
    // <head> is metadata — its <title>, <meta>, <link>, <style> content is never
    // shown to email recipients, so it MUST NOT leak into "visible body" reasoning.
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Evidence gathering (no interpretation) ----

// Probe every outbound link in an email: fetch the page (HEAD-then-GET, following
// redirects) and collect the final URL + page title + visible-text excerpt. ESP
// tracker URLs are followed to their final destination so the QA agent reasons
// about where the link ACTUALLY lands, not the tracker redirector. CTA links are
// also probed — the persona action engine reports whether the persona clicked,
// the probe complements that with destination evidence.
export async function probeEmailLinks(
  email: ParsedEmail,
): Promise<Array<{ url: string; role: 'cta' | 'unsubscribe' | 'other'; probe?: PageFetchResult }>> {
  const seen = new Set<string>();
  const ctaUrl = email.primaryCta?.url;
  const unsubUrl = email.unsubscribeLink;

  const toProbe: { url: string; role: 'cta' | 'unsubscribe' | 'other' }[] = [];
  for (const url of email.links) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (url.startsWith('mailto:')) continue;
    const role: 'cta' | 'unsubscribe' | 'other' =
      url === ctaUrl ? 'cta' : url === unsubUrl ? 'unsubscribe' : 'other';
    toProbe.push({ url, role });
  }

  return Promise.all(
    toProbe.map(async (t) => ({ ...t, probe: await fetchPageContent(t.url).catch(() => undefined) })),
  );
}

export interface LinkProbeForPrompt {
  url: string;
  role: 'cta' | 'unsubscribe' | 'other' | 'tracking';
  fetchOk?: boolean;
  httpStatus?: number;
  finalUrl?: string;
  pageTitle?: string;
  pageTextExcerpt?: string;
}

// ---- The reasoning agent ----
//
// One Gemini call per email. The agent receives evidence (HTML, link probes, CTA click
// result, detected tokens, UTM-on-links flag) and decides which findings deserve
// surfacing AND how to phrase them. No hardcoded "is example.com a placeholder" — the
// agent reasons about it from the URL + the page contents.

const AGENT_CHECK_NAMES = new Set([
  'Primary CTA link',
  'CTA button',
  'Other links',
  'Unsubscribe',
  'Unsubscribe page',
  'Personalization',
  'UTM tracking',
  'Subject',
  'Semantic consistency',
  'Internal text',
]);

interface AgentFinding {
  name?: string;
  status?: string;
  finding?: string;
  fix?: string;
  proof_urls?: string[];
}

export async function reasonOverEmail(opts: {
  campaignName: string;
  expectedFlowText: string;
  email: ParsedEmail;
  personaDisplay: string;
  personaBehavior?: string;
  ctaClickResult?: 'clicked' | 'failed';
  linkProbes: LinkProbeForPrompt[];
}): Promise<ContentCheck[]> {
  if (!geminiConfigured()) return [];
  const { campaignName, expectedFlowText, email, personaDisplay, personaBehavior, ctaClickResult, linkProbes } = opts;
  const visibleBody = visibleHtmlText(email);

  // Trim each probe's page-text excerpt to keep the prompt size reasonable.
  const slimProbes = linkProbes.map((p) => ({
    url: p.url,
    role: p.role,
    fetchOk: p.fetchOk ?? null,
    httpStatus: p.httpStatus ?? null,
    finalUrl: p.finalUrl ?? null,
    pageTitle: p.pageTitle ?? null,
    pageTextExcerpt: (p.pageTextExcerpt || '').slice(0, 280) || null,
  }));

  const prompt = `You are an email-marketing QA agent. You are inspecting ONE captured email and the contents of every landing page it points to. Reason from concrete evidence to decide what to surface as a QA finding.

Return ONLY JSON, no markdown:
{
  "checks": [
    {
      "name": <one of: ${[...AGENT_CHECK_NAMES].map((n) => `"${n}"`).join(', ')}>,
      "status": "fail" | "warn" | "pass",
      "finding": <plain-language explanation, ≤ 22 words, with your reasoning>,
      "fix": <plain-language remediation, ≤ 12 words>,
      "proof_urls": [ <0..3 URLs you are citing as evidence> ]
    }
  ]
}

Rules:
- ALWAYS return one entry for EVERY check name listed above, in that order, for every email — even when there is no issue. This gives consistent reporting across emails. Use status "pass" when nothing is wrong; leave 'finding' and 'fix' empty strings in that case.
- Reason from the evidence you are given. NEVER use HTTP status numbers, generic phrases like "non-2xx", or technical jargon in 'finding'/'fix'. Speak the way a marketer would.
- A URL whose page contents are obviously a documentation placeholder (e.g. IANA's "This domain is for use in illustrative examples", or the page title plainly says it's reserved/example/placeholder) is NOT a real campaign destination, even if it returns 200. Surface it: "Link works but goes to a placeholder URL" or similar phrasing in YOUR own words.
- For 'Primary CTA link': use the CTA click result if given, AND check whether the destination is real / placeholder / a totally different intent than expected.
- 'Unsubscribe' vs 'Unsubscribe page' are STRICTLY separate concerns and must not double-flag the same root cause. Pick exactly one:
  - 'Unsubscribe' = does the email contain ANY unsubscribe mechanism (link in body or List-Unsubscribe URL)? Fail ONLY when no unsubscribe URL was provided at all. If a URL is provided, status "pass" with empty finding — even if the destination is broken or wrong; the destination is the 'Unsubscribe page' check's job.
  - 'Unsubscribe page' = inspect the destination's pageTextExcerpt. If the link is present but the destination is broken, a placeholder, or otherwise doesn't read like a real opt-out flow, fail it here with a reason that explains what the page IS instead. If no unsubscribe URL was provided, status "pass" with empty finding (absence is already covered above).
- For 'CTA button': fail when the visible anchor text is missing, OR is itself a URL/tracking redirect (e.g. https://click.exacttarget.com/…) rather than a human-readable call to action. Tracking/redirect URLs in the HREF are normal and should NOT trigger a finding — only the anchor *text* matters here.
- For 'Personalization': fail when unresolved template tokens are visible in the body (e.g. {{first_name}}, %%FirstName%%, [First Name]). If there are NO tokens at all in the email (the email simply doesn't use personalization), use status "pass" with finding empty. Do NOT claim that personalization "works" or is "verified" when the email contains no personalization in the first place.
- For 'UTM tracking': only flag when CTA-style links are missing campaign tracking parameters. Don't flag unsubscribe links.
- For 'Internal text': only flag visible template-author leakage (TODOs, internal labels, Lorem ipsum, CONTENT_BLOCK_* etc.). If the body is clean, status "pass" with empty finding.
- For 'Subject' / 'Semantic consistency': use reasoning. If everything aligns, status "pass" with empty finding.
- For 'Other links': fail if there's a non-CTA non-unsubscribe link that's broken or otherwise problematic. Otherwise status "pass" with empty finding.
- 'proof_urls' MUST be a subset of the URLs you were given. Cite the specific URL your finding refers to (only for non-pass entries).
- Return EXACTLY one entry per check name listed in the schema. ${[...AGENT_CHECK_NAMES].length} entries total.

Campaign: ${JSON.stringify(campaignName)}
Flow description: ${JSON.stringify(expectedFlowText)}
Persona who received this email: ${JSON.stringify(personaDisplay)}${personaBehavior ? ` (behaviour: ${JSON.stringify(personaBehavior)})` : ''}

Email subject: ${JSON.stringify(email.subject)}
Email body — rendered visible text only (first 2000 chars): ${JSON.stringify(visibleBody.slice(0, 2000))}
Primary CTA anchor text: ${JSON.stringify(email.primaryCta?.text || '')}
Primary CTA URL: ${JSON.stringify(email.primaryCta?.url || '')}
CTA click action by this persona: ${ctaClickResult ? JSON.stringify(ctaClickResult) : '"not attempted"'}
Unsubscribe URL: ${JSON.stringify(email.unsubscribeLink || '')}

Detected unresolved tokens in body: ${JSON.stringify(email.unresolvedTokens || [])}
UTM presence across non-unsub links: ${JSON.stringify(email.trackingParams)}

Link probes (one entry per unique outbound URL in the email, with the page that URL leads to):
${JSON.stringify(slimProbes, null, 2)}
`;

  try {
    const raw = await callGemini(prompt, { fast: false });
    if (!raw) return defaultChecks(email);
    const parsed = tryParseJson<{ checks?: AgentFinding[] }>(raw);
    const ep = emailProof(email)!;
    const byName = new Map<string, ContentCheck>();
    for (const c of parsed?.checks || []) {
      if (!c || typeof c.name !== 'string' || !AGENT_CHECK_NAMES.has(c.name)) continue;
      const status: 'fail' | 'warn' | 'pass' =
        c.status === 'fail' ? 'fail' : c.status === 'pass' ? 'pass' : 'warn';
      const finding = (c.finding || '').slice(0, 220);
      const fix = (c.fix || '').slice(0, 120);
      const proofs: Proof[] = [];
      if (status !== 'pass') proofs.push(ep);
      if (Array.isArray(c.proof_urls)) {
        for (const u of c.proof_urls.slice(0, 3)) {
          if (typeof u !== 'string' || !u) continue;
          const probe = slimProbes.find((p) => p.url === u);
          proofs.push({
            kind: 'link',
            url: probe?.finalUrl || u,
            note: probe?.pageTitle || undefined,
          });
        }
      }
      if (c.name === 'Subject' && status !== 'pass') {
        proofs.push({ kind: 'note', note: `Subject seen: "${email.subject}"` });
      }
      // Last write wins if the agent emitted the same category twice.
      byName.set(c.name, { name: c.name, status, finding, fix, proofs });
    }
    // Guarantee every category is present and in a stable order so all emails
    // in the report show the same set of rows.
    return [...AGENT_CHECK_NAMES].map(
      (name) =>
        byName.get(name) || {
          name,
          status: 'pass',
          finding: '',
          fix: '',
          proofs: [],
        },
    );
  } catch (err) {
    console.warn('[reasonOverEmail] failed:', (err as Error).message);
    return defaultChecks(email);
  }
}

// Stable list of pass-everywhere checks used when the agent call failed entirely.
function defaultChecks(_email: ParsedEmail): ContentCheck[] {
  return [...AGENT_CHECK_NAMES].map((name) => ({
    name,
    status: 'pass' as const,
    finding: '',
    fix: '',
    proofs: [],
  }));
}

// Email HTML sanitizer for rendering inside a sandboxed iframe.
// The iframe (`sandbox=""`, no `allow-scripts`) prevents code execution even if we
// missed something, so we can keep most of the original HTML — including inline
// styles and tables — for an exact visual preview. We still strip executable bits
// as defense in depth.
function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  let s = html
    // Strip executable elements entirely
    .replace(/<\!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    // Strip inline event handlers and javascript: URLs
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  // Cap to 100KB to keep payload reasonable
  return s.slice(0, 100_000);
}

export async function generateQaReport(input: QaReportInput): Promise<QaReport> {
  const { run, paths, emails, actions } = input;
  const personaName = (id: string) => run.expectedFlow.personas.find((p) => p.id === id)?.displayName || id;

  const flowChecks = await buildFlowChecks(input);

  const personaFor = (id: string) => run.expectedFlow.personas.find((p) => p.id === id);

  const emailReports: EmailContentReport[] = await Promise.all(
    emails.map(async (e) => {
      // Evidence gathering: probe every non-tracking link the email points to.
      const linkProbes = await probeEmailLinks(e);
      const flat: LinkProbeForPrompt[] = linkProbes.map((p) => ({
        url: p.url,
        role: p.role,
        fetchOk: p.probe?.ok,
        httpStatus: p.probe?.status,
        finalUrl: p.probe?.finalUrl,
        pageTitle: p.probe?.title,
        pageTextExcerpt: p.probe?.visibleText,
      }));

      // Persona context + CTA click result come from the run state.
      const personaCfg = personaFor(e.persona);
      const action = (actions || []).find((a) => a.persona === e.persona && a.action === 'clicked_primary_cta');
      const ctaClickResult: 'clicked' | 'failed' | undefined = action
        ? action.result === 'clicked'
          ? 'clicked'
          : 'failed'
        : undefined;

      // Single reasoning call. The agent decides which checks to surface and how to
      // phrase them, citing specific URLs as proof.
      const checks = await reasonOverEmail({
        campaignName: run.campaignName,
        expectedFlowText: run.expectedFlowText,
        email: e,
        personaDisplay: personaCfg?.displayName || e.persona,
        personaBehavior: personaCfg?.behavior,
        ctaClickResult,
        linkProbes: flat,
      });

      // Order for readability: failures first, warnings, passes.
      checks.sort((a, b) => {
        const order = { fail: 0, warn: 1, pass: 2 } as const;
        return order[a.status] - order[b.status];
      });

      return {
        emailLabel: e.emailLabel,
        personaDisplay: personaName(e.persona),
        emailId: e.id,
        gmailUrl: gmailMessageUrl(e.id),
        receivedAt: e.date,
        subject: e.subject,
        from: e.from,
        to: e.to,
        bodyText: (e.textBody || '').slice(0, 1500),
        bodyHtml: sanitizeEmailHtml(e.htmlBody || ''),
        checks,
      };
    }),
  );

  const failed =
    flowChecks.some((c) => c.status === 'fail') ||
    emailReports.some((er) => er.checks.some((c) => c.status === 'fail'));

  const replay = buildPersonaReplay({ run, paths, emails, actions });
  const readiness = buildReadiness({ failed, flowChecks, emailReports });

  return {
    result: failed ? 'failed' : 'passed',
    recommendation: failed ? 'Do not launch' : 'Ready to launch',
    readiness,
    replay,
    flowChecks,
    emails: emailReports,
  };
}

function actionVerb(a: PersonaAction['action']): { label: string; status: 'ok' | 'bad' | 'neutral' } {
  switch (a) {
    case 'clicked_primary_cta':
      return { label: 'clicked CTA', status: 'ok' };
    case 'no_click':
      return { label: 'no action', status: 'neutral' };
    case 'opened':
      return { label: 'opened', status: 'ok' };
    case 'replied':
      return { label: 'replied', status: 'ok' };
    case 'unsubscribed':
      return { label: 'unsubscribed', status: 'neutral' };
    case 'failed_to_click':
      return { label: 'click failed', status: 'bad' };
    default:
      return { label: String(a), status: 'neutral' };
  }
}

function buildPersonaReplay(args: {
  run: QaReportInput['run'];
  paths: PathResult[];
  emails: ParsedEmail[];
  actions: PersonaAction[];
}): PersonaReplay[] {
  const { run, paths, emails, actions } = args;
  return run.expectedFlow.personas.map((p) => {
    const personaEmails = emails.filter((e) => e.persona === p.id);
    const personaActions = (actions || []).filter((a) => a.persona === p.id);
    const events: Array<{ time: string; step: ReplayStep }> = [];
    for (const e of personaEmails) {
      events.push({
        time: e.date || '',
        step: {
          kind: 'email_received',
          label: e.emailLabel,
          status: 'ok',
          emailId: e.id,
          gmailUrl: gmailMessageUrl(e.id),
          timestamp: e.date,
        },
      });
    }
    for (const a of personaActions) {
      const v = actionVerb(a.action);
      events.push({
        time: a.timestamp || '',
        step: { kind: 'action', label: v.label, status: v.status, timestamp: a.timestamp },
      });
    }
    events.sort((x, y) => (x.time || '').localeCompare(y.time || ''));
    const steps = events.map((ev) => ev.step);

    const path = paths.find((x) => x.persona === p.id);
    const outcome: PersonaReplay['outcome'] =
      path?.status === 'passed' ? 'passed' : path?.status === 'failed' ? 'failed' : 'partial';
    steps.push({
      kind: 'verdict',
      label: outcome === 'passed' ? 'passed' : outcome === 'failed' ? 'failed' : 'partial',
      status: outcome === 'passed' ? 'ok' : outcome === 'failed' ? 'bad' : 'neutral',
    });

    return {
      personaId: p.id,
      personaName: p.displayName,
      outcome,
      steps,
    };
  });
}

function buildReadiness(args: {
  failed: boolean;
  flowChecks: FlowCheck[];
  emailReports: EmailContentReport[];
}): ReadinessSummary {
  const { failed, flowChecks, emailReports } = args;
  const fixes: { weight: number; text: string }[] = [];

  for (const fc of flowChecks) {
    if (fc.status !== 'pass' && fc.fix) {
      fixes.push({ weight: fc.status === 'fail' ? 3 : 1, text: `${fc.fix} (${fc.name})` });
    }
  }
  for (const er of emailReports) {
    for (const c of er.checks) {
      if (c.status === 'pass') continue;
      const w = c.status === 'fail' ? 3 : 1;
      if (c.fix) fixes.push({ weight: w, text: `${c.fix} — ${er.emailLabel}: ${c.name}` });
    }
  }
  fixes.sort((a, b) => b.weight - a.weight);
  const seenFix = new Set<string>();
  const topFixes: string[] = [];
  for (const f of fixes) {
    const key = f.text.toLowerCase();
    if (seenFix.has(key)) continue;
    seenFix.add(key);
    topFixes.push(f.text);
    if (topFixes.length >= 3) break;
  }

  return {
    decision: failed ? 'Do not launch' : 'Ready to launch',
    topFixes,
    retestRequired: failed,
  };
}
