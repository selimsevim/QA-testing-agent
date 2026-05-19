import { nanoid } from 'nanoid';
import { ExpectedFlow, Finding, ParsedEmail, PathResult, Persona, PersonaAction, PersonaConfig } from '../types';

export interface ValidationResult {
  status: 'ready' | 'failed' | 'running';
  paths: PathResult[];
  findings: Finding[];
}

function findingId() {
  return 'f_' + nanoid(8);
}

function emailLabelsFor(persona: Persona, emails: ParsedEmail[]): string[] {
  return emails.filter((e) => e.persona === persona).map((e) => e.emailLabel);
}

export function validateFlow(input: {
  expectedFlow: ExpectedFlow;
  emails: ParsedEmail[];
  actions: PersonaAction[];
  personas?: PersonaConfig[];
}): ValidationResult {
  const { expectedFlow, emails, actions } = input;
  const personas = input.personas || expectedFlow.personas;
  const findings: Finding[] = [];
  const paths: PathResult[] = [];

  // Build an "exclusive labels per other persona" map for wrong-branch detection.
  // If persona X received an email that belongs ONLY to persona Y's expected list, that's a branch error.
  const expectedByPersona: Record<string, Set<string>> = {};
  for (const b of expectedFlow.branches) {
    expectedByPersona[b.personaId] = new Set(b.expected);
  }

  for (const branch of expectedFlow.branches) {
    const actual = emailLabelsFor(branch.personaId, emails);
    const notes: string[] = [];
    let status: PathResult['status'] = 'passed';

    // Wrong-branch: label received that's in another persona's expected list but NOT in mine
    const myExpected = expectedByPersona[branch.personaId] || new Set<string>();
    for (const lbl of actual) {
      if (myExpected.has(lbl)) continue;
      const otherOwners = Object.entries(expectedByPersona)
        .filter(([pid, set]) => pid !== branch.personaId && set.has(lbl))
        .map(([pid]) => pid);
      if (otherOwners.length) {
        status = 'failed';
        notes.push(`Received ${lbl} (expected for ${otherOwners.join(', ')})`);
        findings.push({
          id: findingId(),
          severity: 'blocker',
          category: 'Flow logic',
          persona: branch.personaId,
          finding: `Received ${lbl}, which is reserved for the ${otherOwners.join(' / ')} branch`,
          suggestedFix: 'Check the journey branch condition that splits these personas',
        });
      }
    }

    // Missing-action follow-up: persona acted (e.g. clicked) but did not receive next expected label
    const personaActed = actions.find((a) => a.persona === branch.personaId);
    if (personaActed && (personaActed.result === 'clicked' || personaActed.result === 'opened' || personaActed.result === 'replied')) {
      const idxFirst = branch.expected[0] ? actual.indexOf(branch.expected[0]) : -1;
      const nextExpected = branch.expected[1];
      if (nextExpected && !actual.includes(nextExpected) && idxFirst >= 0) {
        status = 'failed';
        notes.push(`${nextExpected} did not arrive after the action`);
        findings.push({
          id: findingId(),
          severity: 'blocker',
          category: 'Flow logic',
          persona: branch.personaId,
          finding: `Did not receive ${nextExpected} after the configured action`,
          suggestedFix: 'Verify the engagement trigger and follow-up send condition',
        });
      }
    }

    // Duplicate label warning
    const seen = new Set<string>();
    for (const lbl of actual) {
      if (seen.has(lbl)) {
        findings.push({
          id: findingId(),
          severity: 'warning',
          category: 'Flow logic',
          persona: branch.personaId,
          finding: `Duplicate ${lbl} delivered to ${branch.personaId}`,
          suggestedFix: 'Check send-once rules in the journey',
        });
      }
      seen.add(lbl);
    }

    // Missing expected emails — fail the path AND emit a warning. The wait window may
    // have been too short, but either way the path is not "passed" until everything arrives.
    const missingExpected = branch.expected.filter((e) => !actual.includes(e));
    if (missingExpected.length > 0) {
      if (status !== 'failed') status = 'failed';
      for (const m of missingExpected) notes.push(`${m} not received in test window`);
      findings.push({
        id: findingId(),
        severity: 'warning',
        category: 'Flow logic',
        persona: branch.personaId,
        finding: `${missingExpected.length} expected email${missingExpected.length === 1 ? '' : 's'} not received: ${missingExpected.join(', ')}`,
        suggestedFix: 'Extend the wait period in the flow text, or verify the journey is configured to send these emails',
      });
    }

    paths.push({
      persona: branch.personaId,
      status,
      expected: branch.expected,
      actual,
      notes,
    });
  }

  // Per-email QA findings
  const seenFindingKeys = new Set<string>();
  const pushFinding = (f: Finding) => {
    const key = `${f.category}|${f.persona}|${f.finding}`;
    if (seenFindingKeys.has(key)) return;
    seenFindingKeys.add(key);
    findings.push(f);
  };

  for (const e of emails) {
    if (e.unresolvedTokens && e.unresolvedTokens.length) {
      for (const tok of e.unresolvedTokens) {
        pushFinding({
          id: findingId(),
          severity: 'blocker',
          category: 'Personalization',
          persona: e.persona,
          finding: `Unresolved token ${tok} rendered in email body`,
          suggestedFix: 'Add a fallback value or suppress on missing data',
        });
      }
    }
    if (e.brokenLinks && e.brokenLinks.length) {
      pushFinding({
        id: findingId(),
        severity: 'blocker',
        category: 'Link QA',
        persona: 'All',
        finding: 'Primary CTA returns a non-2xx status on the landing URL',
        suggestedFix: 'Replace the broken campaign URL before launch',
      });
    }
    if (!e.trackingParams.hasUtmCampaign) {
      pushFinding({
        id: findingId(),
        severity: 'warning',
        category: 'Tracking',
        persona: 'All',
        finding: 'Missing utm_campaign parameter on tracked links',
        suggestedFix: 'Add campaign tracking parameters to all CTAs',
      });
    }
    if (!e.unsubscribeLink) {
      pushFinding({
        id: findingId(),
        severity: 'blocker',
        category: 'Unsubscribe',
        persona: 'All',
        finding: 'No unsubscribe link detected in email body or List-Unsubscribe header',
        suggestedFix: 'Add a CAN-SPAM compliant unsubscribe mechanism',
      });
    }
  }

  const overallFailed = paths.some((p) => p.status === 'failed') || findings.some((f) => f.severity === 'blocker');
  return {
    status: overallFailed ? 'failed' : 'ready',
    paths,
    findings,
  };
}
