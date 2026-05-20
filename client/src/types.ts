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
  id: Persona;
  displayName: string;
  alias: string;
  behavior: string;
  behaviorAction: BehaviorAction;
  status: PersonaStatus;
}

export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
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
  durationMs?: number;
  durationLabel?: string;
  expectedLabel?: string;
  expectedPersonas?: Persona[];
  personaId?: Persona;
  action?: BehaviorAction;
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

export interface AgentEvent {
  id: string;
  timestamp: string;
  title: string;
  detail?: string;
  state: 'done' | 'active' | 'pending' | 'fail';
}

export interface PathResult {
  persona: Persona;
  status: 'passed' | 'failed' | 'running' | 'pending';
  expected: string[];
  actual: string[];
  notes: string[];
}

export interface ParsedEmail {
  id: string;
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

export type RunStatus = 'draft' | 'running' | 'failed' | 'ready' | 'cancelled';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export type ProofKind = 'email' | 'link' | 'timestamp' | 'inbox' | 'note';

export interface Proof {
  kind: ProofKind;
  emailId?: string;
  threadId?: string;
  gmailUrl?: string;
  subject?: string;
  to?: string;
  receivedAt?: string;
  snippet?: string;
  url?: string;
  httpStatus?: number;
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
  bodyText?: string;
  bodyHtml?: string;
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

export interface CampaignTrigger {
  vendor: 'sfmc';
  personaAlias?: string;
  contactKey: string;
  email: string;
  eventDefinitionKey: string;
  data?: Record<string, string | number>;
}

export interface TestRun {
  id: string;
  campaignName: string;
  seedInbox: string;
  expectedFlowText: string;
  expectedFlow: ExpectedFlow;
  personas: PersonaConfig[];
  triggers?: CampaignTrigger[];
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  events: AgentEvent[];
  emails: ParsedEmail[];
  actions: any[];
  findings: Finding[];
  paths: PathResult[];
  recommendation?: string;
  qaReport?: QaReport;
  gmailLabelName?: string;
  gmailLabelId?: string;
  currentStepIndex?: number;
  nextStepAt?: string;
  steps?: FlowStep[];
  demoTimeCompression?: number;
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
  triggersFiredAt?: string;
  deliveryElapsedMs?: number;
}

export interface InboxItem {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  unread: boolean;
  labelIds: string[];
}

export interface InboxResponse {
  items: InboxItem[];
  unreadCount: number;
  totalScanned: number;
}

export interface InboxMessageDetail {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  htmlBody: string;
  textBody: string;
  unread: boolean;
}

export interface ConfigResponse {
  mode: 'demo' | 'live';
  geminiConfigured: boolean;
  geminiModel?: string;
  gmailConfigured: boolean;
  gmailConnected: boolean;
  gmailNeedsReauth?: boolean;
  gmailEmail?: string;
  sfmcConfigured?: boolean;
  seedInbox?: string;
}
