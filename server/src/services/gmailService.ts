import { google } from 'googleapis';
import {
  GmailTokens,
  processedEmailKey,
  readGmailCache,
  readGmailTokens,
  writeGmailCache,
  writeGmailTokens,
} from './store';
import { parseGmailMessage, PersonaAliasSpec } from './emailParser';
import { classifyEmailLabel } from './geminiService';
import { ExpectedFlow, ParsedEmail, PersonaConfig } from '../types';

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI2 || 'http://localhost:4000/api/gmail/oauth/callback';
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function gmailConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// gmail.modify lets us read, create labels, and apply labels.
// We never delete or move mail, but the elevated scope is required for label management.
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

export function getAuthUrl(): string | null {
  const oauth = getOAuthClient();
  if (!oauth) return null;
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
  });
}

export async function exchangeCode(code: string): Promise<GmailTokens | null> {
  const oauth = getOAuthClient();
  if (!oauth) return null;
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);
  let email: string | undefined;
  try {
    const oauth2 = google.oauth2({ auth: oauth, version: 'v2' });
    const me = await oauth2.userinfo.get();
    email = me.data.email || undefined;
  } catch {
    email = undefined;
  }
  const stored: GmailTokens = {
    access_token: tokens.access_token || undefined,
    refresh_token: tokens.refresh_token || undefined,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
    expiry_date: tokens.expiry_date || undefined,
    email,
  };
  writeGmailTokens(stored);
  return stored;
}

export function getConnectionStatus(): { connected: boolean; email?: string; needsReauth?: boolean } {
  const t = readGmailTokens();
  if (!t) return { connected: false };
  // The app now needs gmail.modify (was gmail.readonly before). If the stored token
  // is missing that scope, force the user to reconnect.
  const hasModify = (t.scope || '').includes('gmail.modify');
  if (!hasModify) return { connected: false, email: t.email, needsReauth: true };
  return { connected: true, email: t.email };
}

async function getAuthedClient() {
  const oauth = getOAuthClient();
  if (!oauth) return null;
  const t = readGmailTokens();
  if (!t) return null;
  oauth.setCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: t.expiry_date,
    scope: t.scope,
    token_type: t.token_type,
  });
  return oauth;
}

async function inferEmailLabel(opts: {
  subject: string;
  snippet: string;
  personaExpected: string[];
  crossBranchExpected: string[];
  alreadyReceived: string[];
}): Promise<string> {
  const { subject, snippet, personaExpected, crossBranchExpected, alreadyReceived } = opts;
  // No expected labels anywhere (sync called without a flow) — just surface
  // the subject so callers see something meaningful.
  if (!personaExpected.length && !crossBranchExpected.length) {
    return (subject || '').trim() || 'Email';
  }
  const subjLower = (subject || '').toLowerCase();

  // 1) Verbatim match against this persona's expected labels.
  for (const lbl of personaExpected) {
    if (lbl && subjLower.includes(lbl.toLowerCase())) return lbl;
  }

  // 2) Verbatim match against other branches' labels — surfaces wrong-branch
  // deliveries (e.g. a reminder leaking to a clicker), which flowValidator
  // flags as a branch error.
  const otherLabels = crossBranchExpected.filter((l) => !personaExpected.includes(l));
  for (const lbl of otherLabels) {
    if (lbl && subjLower.includes(lbl.toLowerCase())) return lbl;
  }

  // 3) Gemini classify against the full union. Gemini decides whether this
  // email belongs to the persona's expected list or another branch's.
  if (crossBranchExpected.length) {
    try {
      const g = await classifyEmailLabel({ subject, snippet, candidates: crossBranchExpected });
      if (g && crossBranchExpected.includes(g)) return g;
    } catch { /* fall through */ }
  }

  // 4) Positional fallback: pick the next expected label this persona hasn't
  // received yet. Required when labels are generic positional names
  // ("First email", "Reminder email") that don't appear in subjects and that
  // Gemini cannot map semantically.
  const unreceived = personaExpected.filter((l) => !alreadyReceived.includes(l));
  if (unreceived[0]) return unreceived[0];

  // 5) The persona has already received every expected label and nothing else
  // matched — flag as unexpected instead of force-fitting onto an expected
  // slot. This is what catches a reminder leaking to a clicker.
  const tail = (subject || '').trim().slice(0, 80) || 'Email';
  return `Unexpected: ${tail}`;
}

export interface InboxItem {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string;
  date: string;            // ISO-ish; raw Date header from Gmail
  snippet: string;
  unread: boolean;
  labelIds: string[];
}

// Lightweight inbox listing for the Inbox view in the UI. Pulls recent messages
// (in INBOX) and returns a summary plus an unread count for the rail badge.
export async function listInbox(opts: {
  maxResults?: number;
  windowDays?: number;
} = {}): Promise<{ items: InboxItem[]; unreadCount: number; totalScanned: number }> {
  const auth = await getAuthedClient();
  if (!auth) return { items: [], unreadCount: 0, totalScanned: 0 };
  const gmail = google.gmail({ version: 'v1', auth });
  const days = Math.max(1, Math.min(opts.windowDays ?? 1, 14));
  const q = `in:inbox newer_than:${days}d`;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: opts.maxResults || 20,
  });
  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
  const items: InboxItem[] = [];

  for (const id of ids) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      const headers = full.data.payload?.headers || [];
      const get = (n: string) =>
        (headers.find((h: any) => (h.name || '').toLowerCase() === n.toLowerCase())?.value as string | undefined) || '';
      const labelIds = full.data.labelIds || [];
      items.push({
        id: full.data.id!,
        threadId: full.data.threadId || undefined,
        subject: get('Subject') || '(no subject)',
        from: get('From'),
        to: get('To'),
        date: get('Date') || new Date(Number(full.data.internalDate || Date.now())).toISOString(),
        snippet: full.data.snippet || '',
        unread: labelIds.includes('UNREAD'),
        labelIds,
      });
    } catch (err) {
      console.warn('[gmail/listInbox] fetch failed', id, (err as Error).message);
    }
  }
  // Newest first
  items.sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
  const unreadCount = items.filter((i) => i.unread).length;
  return { items, unreadCount, totalScanned: ids.length };
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

// Fetch the full message body for a Gmail id. Used by the Inbox detail panel
// so judges can see the rendered email + click links from inside the UI.
export async function getInboxMessage(id: string): Promise<InboxMessageDetail | null> {
  const auth = await getAuthedClient();
  if (!auth) return null;
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = full.data.payload?.headers || [];
    const get = (n: string) =>
      (headers.find((h: any) => (h.name || '').toLowerCase() === n.toLowerCase())?.value as string | undefined) || '';

    // Reuse the same body-extraction logic as parseGmailMessage by calling the parser.
    // We need just htmlBody / textBody so we re-walk the payload tree here cheaply.
    const parts: Array<{ mime: string; data: string }> = [];
    (function collect(p: any) {
      if (!p) return;
      if (p.body && p.body.data) parts.push({ mime: p.mimeType || 'text/plain', data: p.body.data });
      if (Array.isArray(p.parts)) p.parts.forEach(collect);
    })(full.data.payload);

    const decode = (s: string) => {
      try {
        return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch {
        return '';
      }
    };
    let htmlBody = '';
    let textBody = '';
    for (const p of parts) {
      const m = (p.mime || '').toLowerCase();
      if (m.includes('text/html')) htmlBody += decode(p.data);
      else if (m.includes('text/plain')) textBody += decode(p.data);
    }
    const labelIds = full.data.labelIds || [];
    return {
      id: full.data.id!,
      threadId: full.data.threadId || undefined,
      subject: get('Subject') || '(no subject)',
      from: get('From'),
      to: get('To'),
      date: get('Date') || new Date(Number(full.data.internalDate || Date.now())).toISOString(),
      snippet: full.data.snippet || '',
      htmlBody,
      textBody,
      unread: labelIds.includes('UNREAD'),
    };
  } catch (err) {
    console.warn('[gmail/getInboxMessage] failed', id, (err as Error).message);
    return null;
  }
}

export async function ensureLabel(name: string): Promise<string | null> {
  const auth = await getAuthedClient();
  if (!auth) return null;
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const list = await gmail.users.labels.list({ userId: 'me' });
    const existing = (list.data.labels || []).find((l) => (l.name || '').toLowerCase() === name.toLowerCase());
    if (existing?.id) return existing.id;
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    return created.data.id || null;
  } catch (err) {
    console.warn('[gmail] ensureLabel failed:', (err as Error).message);
    return null;
  }
}

export async function applyLabel(
  messageIds: string[],
  labelId: string,
  opts: { archiveFromInbox?: boolean } = {},
): Promise<number> {
  if (!messageIds.length || !labelId) return 0;
  const auth = await getAuthedClient();
  if (!auth) return 0;
  const gmail = google.gmail({ version: 'v1', auth });
  let applied = 0;
  // batchModify supports up to 1000 ids per call; chunk just in case.
  const chunkSize = 500;
  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const ids = messageIds.slice(i, i + chunkSize);
    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids,
          addLabelIds: [labelId],
          removeLabelIds: opts.archiveFromInbox ? ['INBOX'] : undefined,
        },
      });
      applied += ids.length;
    } catch (err) {
      console.warn('[gmail] applyLabel batch failed:', (err as Error).message);
    }
  }
  return applied;
}

export async function syncMessages(opts: {
  campaignName: string;
  seedInbox: string;
  personas: PersonaConfig[];
  expectedFlow?: ExpectedFlow;
  // Labels already captured for each persona in earlier syncs of this run.
  // Used as the positional fallback inside inferEmailLabel so the next sync
  // picks the next-expected label instead of the persona's first one again.
  alreadyReceivedByPersona?: Record<string, string[]>;
  // Set of `${alias}|${emailDate}` keys for emails this campaign has already
  // processed in earlier runs. Matching candidates are filtered out before any
  // label-classification work, so re-runs don't double-count.
  excludeKeys?: Set<string>;
  maxResults?: number;
  windowDays?: number;
}): Promise<{
  emails: ParsedEmail[];
  query: string;
  totalScanned: number;
  droppedNoPersona: number;
  droppedAlreadyProcessed: number;
}> {
  const auth = await getAuthedClient();
  if (!auth) {
    return { emails: [], query: '', totalScanned: 0, droppedNoPersona: 0, droppedAlreadyProcessed: 0 };
  }
  const gmail = google.gmail({ version: 'v1', auth });

  // We deliberately do NOT lock the query to a specific recipient address NOR to the
  // campaign name. SFMC sandboxes redirect to inbox aliases where the persona tag lives on
  // some other local part, and SFMC subjects rarely match the campaign label in this tool.
  // The real signal is the persona alias on a recipient header, which we filter in JS.
  const days = Math.max(1, Math.min(opts.windowDays ?? 1, 30));
  const query = `newer_than:${days}d`;

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: opts.maxResults || 50,
  });
  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
  const emails: ParsedEmail[] = [];
  let droppedNoPersona = 0;

  const aliasSpecs: PersonaAliasSpec[] = (opts.personas || []).map((p) => ({ id: p.id, alias: p.alias }));
  const aliasTokens = aliasSpecs.map((s) => s.alias.toLowerCase()).filter(Boolean);
  const aliasByPersonaId: Record<string, string> = {};
  for (const s of aliasSpecs) aliasByPersonaId[s.id] = s.alias;
  const excludeKeys = opts.excludeKeys || new Set<string>();
  const recipientHeaders = new Set(['to', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'cc', 'bcc', 'x-rcpt-to', 'envelope-to']);

  const expectedByPersona: Record<string, string[]> = {};
  for (const b of opts.expectedFlow?.branches || []) {
    expectedByPersona[b.personaId] = b.expected || [];
  }
  const crossBranchExpected = Array.from(new Set(Object.values(expectedByPersona).flat()));
  const alreadyByPersona: Record<string, string[]> = { ...(opts.alreadyReceivedByPersona || {}) };

  // Fetch all messages in parallel, then parse + persona-detect synchronously,
  // then classify labels (only Gemini path is async) in parallel.
  const fetched = await Promise.all(
    ids.map(async (id) => {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        return { id, full };
      } catch (err) {
        console.warn('[gmail] failed to fetch message', id, (err as Error).message);
        return null;
      }
    }),
  );

  // First pass: parse, detect persona, drop non-matches and already-processed
  let droppedAlreadyProcessed = 0;
  const candidates: { parsed: ParsedEmail; subject: string; snippet: string }[] = [];
  for (const f of fetched) {
    if (!f) continue;
    const { full } = f;
    const headers = full.data.payload?.headers || [];
    const subject = (headers.find((h: any) => (h.name || '').toLowerCase() === 'subject')?.value) || '';
    const snippet = full.data.snippet || '';

    const headerMap: Record<string, string> = {};
    for (const h of headers) headerMap[((h as any).name || '').toLowerCase()] = String((h as any).value || '');
    const recipBlob = Array.from(Object.entries(headerMap))
      .filter(([k]) => recipientHeaders.has(k))
      .map(([, v]) => v)
      .join(' ')
      .toLowerCase();
    const hasAlias = aliasTokens.some((a) => recipBlob.includes(a) || snippet.toLowerCase().includes(a));
    if (!hasAlias) {
      droppedNoPersona += 1;
      continue;
    }

    const parsed = parseGmailMessage(
      {
        id: full.data.id!,
        threadId: full.data.threadId || undefined,
        payload: full.data.payload,
        internalDate: full.data.internalDate || undefined,
        snippet,
      },
      'Unknown',
      aliasSpecs,
    );
    // Cross-run dedupe: if (alias, send time) is already recorded for this campaign,
    // skip — an earlier run already counted this email.
    const matchedAlias = aliasByPersonaId[parsed.persona] || '';
    if (matchedAlias && excludeKeys.has(processedEmailKey(matchedAlias, parsed.date))) {
      droppedAlreadyProcessed += 1;
      continue;
    }
    candidates.push({ parsed, subject, snippet });
  }

  // Second pass: classify labels. Done sequentially per-persona so the
  // positional fallback inside inferEmailLabel sees each prior label this
  // sync just assigned. Different personas can still run in parallel.
  const byPersona: Record<string, typeof candidates> = {};
  for (const c of candidates) (byPersona[c.parsed.persona] ||= []).push(c);
  await Promise.all(
    Object.entries(byPersona).map(async ([personaId, group]) => {
      // Stable order so repeated runs yield deterministic positional labels.
      group.sort((a, b) => (a.parsed.date || '').localeCompare(b.parsed.date || ''));
      for (const { parsed, subject, snippet } of group) {
        const received = alreadyByPersona[personaId] || [];
        parsed.emailLabel = await inferEmailLabel({
          subject,
          snippet,
          personaExpected: expectedByPersona[personaId] || [],
          crossBranchExpected,
          alreadyReceived: received,
        });
        alreadyByPersona[personaId] = [...received, parsed.emailLabel];
      }
    }),
  );
  emails.push(...candidates.map((c) => c.parsed));
  writeGmailCache({ messages: emails, fetchedAt: new Date().toISOString(), query });
  return { emails, query, totalScanned: ids.length, droppedNoPersona, droppedAlreadyProcessed };
}

export function getCachedMessages(): ParsedEmail[] {
  const c = readGmailCache();
  return Array.isArray(c.messages) ? c.messages : [];
}

// Lightweight detection used by the delivery-wait poll loop. Just lists
// message ids in the last day and inspects metadata headers — no body parse,
// no Gemini classification, no cache write. Returns the set of persona aliases
// that have at least one matching message in the mailbox right now.
export async function peekForArrivals(opts: {
  aliases: string[];
  excludeKeys?: Set<string>;
  windowDays?: number;
  maxResults?: number;
}): Promise<{ matchedAliases: Set<string>; totalScanned: number }> {
  const auth = await getAuthedClient();
  const matched = new Set<string>();
  if (!auth || !opts.aliases.length) return { matchedAliases: matched, totalScanned: 0 };
  const gmail = google.gmail({ version: 'v1', auth });
  const days = Math.max(1, Math.min(opts.windowDays ?? 1, 30));
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `newer_than:${days}d`,
    maxResults: opts.maxResults || 50,
  });
  const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
  const aliasTokens = opts.aliases.map((a) => a.toLowerCase()).filter(Boolean);
  const recipientHeaders = ['to', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'cc', 'bcc', 'x-rcpt-to', 'envelope-to'];
  const excludeKeys = opts.excludeKeys || new Set<string>();

  await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: [...recipientHeaders.map((h) => h.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase())), 'Date'],
        });
        const headers = meta.data.payload?.headers || [];
        const headerMap: Record<string, string> = {};
        for (const h of headers) headerMap[((h as any).name || '').toLowerCase()] = String((h as any).value || '');
        const recipBlob = recipientHeaders
          .map((k) => headerMap[k] || '')
          .join(' ')
          .toLowerCase();
        const date = headerMap['date'] || '';
        for (const alias of aliasTokens) {
          if (!recipBlob.includes(alias)) continue;
          // Skip messages already counted by a prior run for this campaign.
          if (excludeKeys.size && date && excludeKeys.has(processedEmailKey(alias, date))) continue;
          matched.add(alias);
        }
      } catch {
        /* ignore individual fetch failures during polling */
      }
    }),
  );

  return { matchedAliases: matched, totalScanned: ids.length };
}
