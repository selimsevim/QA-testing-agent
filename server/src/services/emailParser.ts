import { ParsedEmail, Persona } from '../types';

const CTA_KEYWORDS = ['book', 'explore', 'learn more', 'get started', 'confirm', 'view', 'shop', 'try', 'start now', 'continue'];

const TOKEN_PATTERNS = [
  /%%([A-Za-z0-9 _.-]+)%%/g,
  /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
  /\[First Name\]/gi,
  /\[Last Name\]/gi,
];

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ href: m[1], text: stripHtml(m[2]).trim() });
  }
  // raw urls
  const rawRe = /(https?:\/\/[^\s<>"')]+)/g;
  const stripped = stripHtml(html);
  let rm: RegExpExecArray | null;
  while ((rm = rawRe.exec(stripped))) {
    if (!out.find((x) => x.href === rm![1])) out.push({ href: rm[1], text: rm[1] });
  }
  return out;
}

export function detectPrimaryCta(links: { href: string; text: string }[]): { url: string; text: string } | undefined {
  // ignore unsubscribe links
  const candidates = links.filter((l) => !isUnsubscribe(l.href, l.text));
  if (!candidates.length) return undefined;
  // Prefer links whose anchor text is human-readable. extractLinks also yields
  // entries for raw URLs found as plain text (text === href); those are almost
  // never the real CTA button and would otherwise win the first-match fallback
  // and confuse downstream QA into reporting "visible text is a raw URL".
  const isUrlLike = (t: string, href: string) => {
    const s = (t || '').trim();
    return !s || /^https?:\/\//i.test(s) || s === href;
  };
  const named = candidates.filter((l) => !isUrlLike(l.text, l.href));
  const pool = named.length ? named : candidates;
  for (const kw of CTA_KEYWORDS) {
    const m = pool.find((l) => l.text.toLowerCase().includes(kw));
    if (m) return { url: m.href, text: m.text };
  }
  return { url: pool[0].href, text: pool[0].text || pool[0].href };
}

export function isUnsubscribe(href: string, text: string): boolean {
  const blob = `${href} ${text}`.toLowerCase();
  return blob.includes('unsubscribe') || blob.includes('opt-out') || blob.includes('opt_out');
}

export function detectUnsubscribeLink(
  links: { href: string; text: string }[],
  headers?: Record<string, string>,
): string | undefined {
  const found = links.find((l) => isUnsubscribe(l.href, l.text));
  if (found) return found.href;
  if (headers && headers['list-unsubscribe']) return headers['list-unsubscribe'];
  return undefined;
}

export function detectUnresolvedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const re of TOKEN_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text))) {
      tokens.add(m[0]);
    }
  }
  return Array.from(tokens);
}

export function detectTracking(links: { href: string; text: string }[]): {
  hasUtmSource: boolean;
  hasUtmMedium: boolean;
  hasUtmCampaign: boolean;
} {
  const nonUnsub = links.filter((l) => !isUnsubscribe(l.href, l.text));
  const all = nonUnsub.map((l) => l.href.toLowerCase()).join(' ');
  return {
    hasUtmSource: all.includes('utm_source='),
    hasUtmMedium: all.includes('utm_medium='),
    hasUtmCampaign: all.includes('utm_campaign='),
  };
}

export interface PersonaAliasSpec {
  id: Persona;
  alias: string; // e.g. '+clicker'
}

// Order matches longest-alias-first so 'nonclicker' wins over 'clicker' when both contain '+clicker'.
function rankedAliases(specs: PersonaAliasSpec[]): PersonaAliasSpec[] {
  return [...specs].sort((a, b) => b.alias.length - a.alias.length);
}

export function detectPersonaFromText(text: string, specs: PersonaAliasSpec[]): Persona | undefined {
  const t = (text || '').toLowerCase();
  for (const s of rankedAliases(specs)) {
    const alias = s.alias.toLowerCase();
    if (alias && t.includes(alias)) return s.id;
  }
  return undefined;
}

export function detectPersonaFromHeaders(
  headerMap: Record<string, string>,
  specs: PersonaAliasSpec[],
  snippet?: string,
): Persona | undefined {
  const recipKeys = ['to', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'cc', 'bcc', 'x-rcpt-to', 'envelope-to'];
  for (const key of recipKeys) {
    const v = headerMap[key];
    if (!v) continue;
    const p = detectPersonaFromText(v, specs);
    if (p) return p;
  }
  if (snippet) {
    const p = detectPersonaFromText(snippet, specs);
    if (p) return p;
  }
  return undefined;
}

export interface GmailRawMessage {
  id: string;
  threadId?: string;
  payload?: any;
  internalDate?: string;
  snippet?: string;
}

function collectParts(payload: any, out: { mime: string; data: string }[] = []): { mime: string; data: string }[] {
  if (!payload) return out;
  if (payload.body && payload.body.data) {
    out.push({ mime: payload.mimeType || 'text/plain', data: payload.body.data });
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectParts(p, out);
  }
  return out;
}

function getHeader(headers: any[] | undefined, name: string): string {
  if (!headers) return '';
  const h = headers.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

export function parseGmailMessage(msg: GmailRawMessage, emailLabel = 'Unknown', personaSpecs: PersonaAliasSpec[] = []): ParsedEmail {
  const headers: any[] = msg.payload?.headers || [];
  const headerMap: Record<string, string> = {};
  for (const h of headers) headerMap[(h.name || '').toLowerCase()] = String(h.value || '');

  const subject = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To') || getHeader(headers, 'Delivered-To');
  const date = getHeader(headers, 'Date') || new Date(Number(msg.internalDate || Date.now())).toISOString();

  const parts = collectParts(msg.payload, []);
  let textBody = '';
  let htmlBody = '';
  for (const p of parts) {
    const decoded = decodeBase64Url(p.data);
    if (p.mime.toLowerCase().includes('text/html')) htmlBody += decoded;
    else if (p.mime.toLowerCase().includes('text/plain')) textBody += decoded;
  }
  if (!textBody && htmlBody) textBody = stripHtml(htmlBody);

  const linkObjs = extractLinks(htmlBody || textBody);
  const links = linkObjs.map((l) => l.href);
  const primaryCta = detectPrimaryCta(linkObjs);
  const unsubscribeLink = detectUnsubscribeLink(linkObjs, headerMap);
  const tokens = detectUnresolvedTokens((textBody || '') + ' ' + (htmlBody || ''));
  const tracking = detectTracking(linkObjs);
  const persona = detectPersonaFromHeaders(headerMap, personaSpecs, msg.snippet) || personaSpecs[0]?.id || 'unknown';

  const qaFlags: string[] = [];
  if (tokens.length) qaFlags.push('unresolved_tokens');
  if (!unsubscribeLink) qaFlags.push('missing_unsubscribe');
  if (!tracking.hasUtmCampaign) qaFlags.push('missing_utm_campaign');

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject,
    from,
    to,
    date,
    textBody,
    htmlBody,
    links,
    primaryCta,
    unsubscribeLink,
    unresolvedTokens: tokens,
    trackingParams: tracking,
    brokenLinks: [],
    persona,
    emailLabel,
    qaFlags,
  };
}

export function parseSimpleEmail(input: {
  id: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  htmlBody: string;
  textBody?: string;
  persona: Persona;
  emailLabel: string;
}): ParsedEmail {
  const linkObjs = extractLinks(input.htmlBody);
  const links = linkObjs.map((l) => l.href);
  const primaryCta = detectPrimaryCta(linkObjs);
  const unsubscribeLink = detectUnsubscribeLink(linkObjs);
  const text = input.textBody || stripHtml(input.htmlBody);
  const tokens = detectUnresolvedTokens(text + ' ' + input.htmlBody);
  const tracking = detectTracking(linkObjs);
  const qaFlags: string[] = [];
  if (tokens.length) qaFlags.push('unresolved_tokens');
  if (!unsubscribeLink) qaFlags.push('missing_unsubscribe');
  if (!tracking.hasUtmCampaign) qaFlags.push('missing_utm_campaign');
  return {
    id: input.id,
    subject: input.subject,
    from: input.from,
    to: input.to,
    date: input.date,
    textBody: text,
    htmlBody: input.htmlBody,
    links,
    primaryCta,
    unsubscribeLink,
    unresolvedTokens: tokens,
    trackingParams: tracking,
    brokenLinks: [],
    persona: input.persona,
    emailLabel: input.emailLabel,
    qaFlags,
  };
}
