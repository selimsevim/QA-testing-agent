// Persona is now an open string id. The agent infers it from the user's flow text.
export type Persona = string;

export type PersonaStatus =
  | 'waiting'
  | 'watching'
  | 'email_received'
  | 'cta_clicked'
  | 'no_interaction'
  | 'passed'
  | 'failed'
  | 'branch_error';

export type BehaviorAction =
  | 'click_primary_cta'
  | 'no_action'
  | 'open_only'
  | 'reply'
  | 'unsubscribe'
  | 'submit_form'
  | 'custom';

export interface PersonaConfig {
  id: Persona;             // slug, e.g. 'clicker', 'opener', 'unsubscriber'
  displayName: string;     // human label, e.g. 'Clicker', 'Opener'
  alias: string;           // recipient tag to look for, e.g. '+clicker'
  behavior: string;        // free-text description for the UI
  behaviorAction: BehaviorAction;
  status: PersonaStatus;
}

export type Severity = 'blocker' | 'warning' | 'info';

export type FindingCategory =
  | 'Flow logic'
  | 'Personalization'
  | 'Link QA'
  | 'Tracking'
  | 'Content consistency'
  | 'Unsubscribe'
  | 'Subject';

export interface Finding {
  id: string;
  severity: Severity;
  category: FindingCategory;
  persona: Persona | 'All';
  finding: string;
  suggestedFix: string;
}

export interface ExpectedFlowBranch {
  personaId: Persona;
  expected: string[];
}

export type StepKind = 'start' | 'sync' | 'wait' | 'action' | 'validate' | 'report';

export interface FlowStep {
  id: string;
  kind: StepKind;
  descr: string;
  // wait
  durationMs?: number;
  durationLabel?: string;
  // sync
  expectedLabel?: string;
  expectedPersonas?: Persona[];
  // action
  personaId?: Persona;
  action?: BehaviorAction;
  // runtime
  state?: 'pending' | 'active' | 'done' | 'fail' | 'skipped';
  startedAt?: string;
  endedAt?: string;
}

export interface ExpectedFlow {
  totalEmails: number;
  entryTrigger: string;
  personas: PersonaConfig[];
  branches: ExpectedFlowBranch[];
  steps: FlowStep[];
}

export interface ParsedEmail {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  textBody: string;
  htmlBody: string;
  links: string[];
  primaryCta?: { text: string; url: string };
  unsubscribeLink?: string;
  unresolvedTokens: string[];
  trackingParams: { hasUtmSource: boolean; hasUtmMedium: boolean; hasUtmCampaign: boolean };
  brokenLinks: string[];
  persona: Persona;
  emailLabel: string;
  qaFlags: string[];
}

export interface AgentEvent {
  id: string;
  timestamp: string;
  title: string;
  detail?: string;
  state: 'done' | 'active' | 'pending' | 'fail';
}

export interface PersonaAction {
  persona: Persona;
  // The actual link the user clicked (the in-email href, often an ESP tracking
  // redirect like cl.s51.exct.net). Useful for proof but not for display.
  url?: string;
  // The destination URL the click resolved to after redirects. ALWAYS prefer
  // this for any user-facing rendering — the tracking URL is meaningless to
  // a marketer reviewing the report.
  finalUrl?: string;
  action: 'clicked_primary_cta' | 'no_click' | 'failed_to_click' | 'opened' | 'replied' | 'unsubscribed';
  timestamp: string;
  result?: 'clicked' | 'failed' | 'opened' | 'replied' | 'unsubscribed';
}

export interface PathResult {
  persona: Persona;
  status: 'passed' | 'failed' | 'running' | 'pending';
  expected: string[];
  actual: string[];
  notes: string[];
}

export type RunStatus = 'draft' | 'running' | 'failed' | 'ready' | 'cancelled';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export type ProofKind = 'email' | 'link' | 'timestamp' | 'inbox' | 'note';

export interface Proof {
  kind: ProofKind;
  // email
  emailId?: string;
  threadId?: string;
  gmailUrl?: string;
  subject?: string;
  to?: string;
  receivedAt?: string;
  snippet?: string;
  // link
  url?: string;
  httpStatus?: number;
  // generic
  timestamp?: string;
  note?: string;
}

export interface FlowCheck {
  name: string;
  expected: string;
  actual: string;
  status: CheckStatus;
  fix: string;
  proofs?: Proof[];
}

export interface ContentCheck {
  name: string;
  status: CheckStatus;
  finding: string;
  fix: string;
  proofs?: Proof[];
}

export interface EmailContentReport {
  emailLabel: string;
  personaDisplay: string;
  emailId?: string;
  gmailUrl?: string;
  receivedAt?: string;
  subject?: string;
  from?: string;
  to?: string;
  bodyText?: string;     // first ~1500 chars of plain visible text
  bodyHtml?: string;     // sanitized HTML for inline rendering (no scripts/iframes/styles)
  checks: ContentCheck[];
}

export type ReplayStepKind = 'email_received' | 'action' | 'verdict';

export interface ReplayStep {
  kind: ReplayStepKind;
  label: string;
  status: 'ok' | 'bad' | 'neutral';
  emailId?: string;
  gmailUrl?: string;
  timestamp?: string;
}

export interface PersonaReplay {
  personaId: string;
  personaName: string;
  outcome: 'passed' | 'failed' | 'partial';
  steps: ReplayStep[];
}

export interface ReadinessSummary {
  decision: 'Ready to launch' | 'Do not launch';
  topFixes: string[];
  retestRequired: boolean;
}

export interface QaReport {
  result: 'passed' | 'failed';
  recommendation: 'Do not launch' | 'Ready to launch';
  readiness: ReadinessSummary;
  replay: PersonaReplay[];
  flowChecks: FlowCheck[];
  emails: EmailContentReport[];
}

export interface TestRunReport {
  campaignName: string;
  testRunId: string;
  createdAt: string;
  overall: RunStatus;
  recommendation: string;
  summary: {
    emailsExpected: number;
    emailsReceived: number;
    pathsTested: number;
    blockers: number;
    warnings: number;
  };
  paths: PathResult[];
  findings: Finding[];
  events: AgentEvent[];
  emails: ParsedEmail[];
  personas: PersonaConfig[];
  expectedFlow: ExpectedFlow;
  qaReport?: QaReport;
}

export interface TestRun {
  id: string;
  campaignName: string;
  seedInbox: string;
  expectedFlowText: string;
  expectedFlow: ExpectedFlow;
  personas: PersonaConfig[];
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  events: AgentEvent[];
  emails: ParsedEmail[];
  actions: PersonaAction[];
  findings: Finding[];
  paths: PathResult[];
  recommendation?: string;
  qaReport?: QaReport;
  gmailLabelName?: string;
  gmailLabelId?: string;
  // step runtime
  currentStepIndex?: number;
  nextStepAt?: string;
  steps?: FlowStep[];
  // Set by the cancel endpoint; the runner checks it between awaits.
  cancelRequested?: boolean;
}
