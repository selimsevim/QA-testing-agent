import { AgentEvent, Persona, PersonaConfig, TestRun } from '../types';
import { parseSimpleEmail } from './emailParser';
import { checkEmailLinks } from './linkChecker';
import { updateTestRun } from './store';

// The demo injector adds simulated emails to the run during sync steps. It is persona-agnostic:
// it inspects the parsed personas and generates a plausible email per persona for the next
// expected label.

function nowIso() {
  return new Date().toISOString();
}

function nextExpectedLabel(run: TestRun, persona: Persona): string | undefined {
  const branch = run.expectedFlow.branches.find((b) => b.personaId === persona);
  if (!branch) return undefined;
  const received = new Set(run.emails.filter((e) => e.persona === persona).map((e) => e.emailLabel));
  for (const lbl of branch.expected) {
    if (!received.has(lbl)) return lbl;
  }
  return undefined;
}

function emailHtml(opts: {
  campaignName: string;
  persona: PersonaConfig;
  emailLabel: string;
  flawed: boolean;
}): string {
  const ctaUrl = opts.flawed
    ? 'https://example.com/broken-campaign-link'
    : `https://example.com/offer?utm_source=email&utm_medium=lifecycle&utm_campaign=${slug(opts.campaignName)}`;
  const greeting = opts.flawed ? 'Hi %%FirstName%%,' : 'Hi there,';
  const ctaText = opts.persona.behaviorAction === 'click_primary_cta' ? 'Explore offer' : 'Learn more';
  return `<html><body>
<p>${greeting}</p>
<p>${opts.emailLabel} from ${opts.campaignName}.</p>
<p><a href="${ctaUrl}" style="background:#15171C;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none;">${ctaText}</a></p>
<p style="font-size:11px;color:#888"><a href="https://example.com/unsubscribe?u=123">Unsubscribe</a></p>
</body></html>`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export async function injectDemoEmails(
  run: TestRun,
  ctx: {
    pushEvent: (ev: Omit<AgentEvent, 'id'>) => void;
    markPersonaStatus: (p: Persona, s: any) => void;
  },
): Promise<void> {
  // For each persona, look at what they should next receive and inject that email.
  // We inject one email per persona per sync step. To make the demo realistic for
  // the "branch mis-routing" scenario, we deliberately mis-deliver the click-only
  // follow-up to ALL personas when more than one persona's flow includes a "2A"-like
  // label and the action persona has already acted.
  const justInjected: { persona: Persona; emailLabel: string }[] = [];
  for (const persona of run.personas) {
    let label = nextExpectedLabel(run, persona.id);
    if (!label) continue;

    // Special demo flair: if this persona is supposed to get "Reminder 2B" but the
    // clicker has already received their "Email 2A" via this sync, demo a journey bug
    // by mis-routing the clicker email to this persona.
    if (/reminder/i.test(label) || /2b$/i.test(label)) {
      const clicker = run.personas.find((p) => p.behaviorAction === 'click_primary_cta');
      const clickerLabel = clicker ? run.expectedFlow.branches.find((b) => b.personaId === clicker.id)?.expected[1] : undefined;
      const clickerHasActed = !!run.actions.find((a) => a.persona === clicker?.id && a.result === 'clicked');
      const clickerAlreadyDelivered = run.emails.some((e) => e.persona === clicker?.id && e.emailLabel === clickerLabel);
      if (clicker && clickerLabel && clickerHasActed && clickerAlreadyDelivered) {
        label = clickerLabel; // mis-routed!
      }
    }

    const flawed = label === run.expectedFlow.branches[0]?.expected[0] && persona.behaviorAction === 'click_primary_cta';
    const html = emailHtml({ campaignName: run.campaignName, persona, emailLabel: label, flawed });
    const parsed = parseSimpleEmail({
      id: `demo_${persona.id}_${slug(label)}_${Math.random().toString(36).slice(2, 6)}`,
      subject: subjectFor(label),
      from: `${run.campaignName} <hello@acme.example>`,
      to: `seed${persona.alias}@gmail.com`,
      date: nowIso(),
      htmlBody: html,
      persona: persona.id,
      emailLabel: label,
    });
    parsed.brokenLinks = (await checkEmailLinks(parsed, true)).broken;
    updateTestRun(run.id, (r) => r.emails.push(parsed));
    justInjected.push({ persona: persona.id, emailLabel: label });
    ctx.markPersonaStatus(persona.id, 'email_received');
    ctx.pushEvent({
      timestamp: nowIso(),
      title: `${label} received for ${persona.displayName}`,
      detail: `subject "${parsed.subject}"`,
      state: 'done',
    });
  }
  if (!justInjected.length) {
    ctx.pushEvent({ timestamp: nowIso(), title: 'No new emails in this sync window', state: 'done' });
  }
}

function subjectFor(label: string): string {
  if (/email\s*1/i.test(label)) return 'Welcome aboard';
  if (/2a/i.test(label)) return 'Great choice — next steps';
  if (/2b|reminder/i.test(label)) return 'Quick reminder';
  if (/final|3/i.test(label)) return "You're all set";
  return label;
}
