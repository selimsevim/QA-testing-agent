import { BehaviorAction, ParsedEmail, Persona, PersonaAction } from '../types';

// Domains where ANY HTTP request (even HEAD) is recorded as a click by the ESP. We must
// never auto-touch these from a link health check — only an explicit persona click action
// is allowed to hit them.
export function isTrackingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Common ESP trackers: cl.s##.exct.net, *.exct.net, *.exacttarget.com
    if (/^cl\.s\d+\.exct\.net$/.test(host)) return true;
    if (host.endsWith('.exct.net') || host === 'exct.net') return true;
    if (host.endsWith('.exacttarget.com') || host === 'exacttarget.com') return true;
    // Generic patterns: any host whose label starts with click., track., links., t.,
    // or contains those tokens (links.email.example.com, click.email.example.com, etc.)
    if (/(^|\.)(click|track|trk|links?|email|cl|t)\./.test(host)) return true;
    // Common ESP click trackers
    if (host.includes('mailchimp') || host.includes('mandrillapp')) return true;
    if (host.includes('hubspot') || host.includes('hsforms')) return true;
    if (host.includes('klaviyo') || host.includes('kl.email')) return true;
    if (host.includes('marketo') || host.includes('mktoresp')) return true;
    if (host.includes('iterable') || host.includes('itbl')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function checkLink(url: string): Promise<{ ok: boolean; status: number; finalUrl: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.status >= 200 && res.status < 400, status: res.status, finalUrl: res.url || url };
  } catch {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      return { ok: res.status >= 200 && res.status < 400, status: res.status, finalUrl: res.url || url };
    } catch {
      return { ok: false, status: 0, finalUrl: url };
    }
  }
}

// Resolve an ESP tracker URL to its eventual destination by following redirects.
// We follow with HEAD first (cheap) and fall back to GET. Result is the URL the
// browser would have landed on. Hitting a tracker registers as a click in the
// ESP — callers must only invoke this on links they are willing to log a click for.
export async function resolveFinalUrl(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (res.url) return res.url;
  } catch {}
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (res.url) return res.url;
  } catch {}
  return url;
}

export interface PageFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  title?: string;
  visibleText?: string;
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : undefined;
}

function htmlToVisibleText(html: string): string {
  return html
    // <head>'s metadata (title/meta/link) is never visible to a reader. extractTitle
    // already captures <title> separately, so we strip <head> for the visible text.
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetches a page and extracts title + first-page text content. Used for semantic
// landing-page validation (does the unsubscribe link actually go somewhere that lets
// the user unsubscribe?). Bounded by timeout and a 200KB read cap.
export async function fetchPageContent(url: string): Promise<PageFetchResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'InboxFlowAgent/1.0' },
    });
    clearTimeout(timeout);
    const ok = res.status >= 200 && res.status < 400;
    const finalUrl = res.url || url;
    let raw = '';
    try {
      raw = (await res.text()).slice(0, 200_000);
    } catch {}
    return {
      ok,
      status: res.status,
      finalUrl,
      title: extractTitle(raw),
      visibleText: htmlToVisibleText(raw).slice(0, 800),
    };
  } catch {
    return { ok: false, status: 0, finalUrl: url };
  }
}

export interface LinkScanResult {
  broken: string[];
  checked: string[];
  // Map of initial URL → resolved final URL after redirects. Populated for any
  // link the scanner actually probed (so callers can show "tracker → final" in UI).
  finalUrls: Record<string, string>;
  skipped: { url: string; reason: 'tracking' | 'cta' | 'unsubscribe' | 'mailto' | 'duplicate' }[];
}

export async function checkEmailLinks(email: ParsedEmail): Promise<LinkScanResult> {
  const broken: string[] = [];
  const checked: string[] = [];
  const finalUrls: Record<string, string> = {};
  const skipped: LinkScanResult['skipped'] = [];
  const seen = new Set<string>();
  const seenFinal = new Set<string>();
  const ctaUrl = email.primaryCta?.url;
  for (const url of email.links) {
    if (seen.has(url)) {
      skipped.push({ url, reason: 'duplicate' });
      continue;
    }
    seen.add(url);
    if (url.startsWith('mailto:')) {
      skipped.push({ url, reason: 'mailto' });
      continue;
    }
    if (ctaUrl && url === ctaUrl) {
      // The primary CTA is reserved for the persona's click action engine. Auto-touching
      // it from a health check would register a false click in the ESP.
      skipped.push({ url, reason: 'cta' });
      continue;
    }
    if (email.unsubscribeLink && url === email.unsubscribeLink) {
      // Unsubscribe has a dedicated persona action — never auto-trigger it from a
      // health probe (would actually unsubscribe the test inbox).
      skipped.push({ url, reason: 'unsubscribe' });
      continue;
    }
    // For ESP tracker URLs the meaningful health check is the FINAL destination,
    // not the redirector itself (which always 30x's and is therefore uninformative).
    // checkLink already follows redirects, so the status reflects the landing page,
    // and finalUrl tells us where we ended up. Skip duplicates by final URL.
    const res = await checkLink(url);
    if (seenFinal.has(res.finalUrl)) {
      skipped.push({ url, reason: 'duplicate' });
      continue;
    }
    seenFinal.add(res.finalUrl);
    checked.push(url);
    finalUrls[url] = res.finalUrl;
    if (!res.ok) broken.push(res.finalUrl);
  }
  return { broken, checked, finalUrls, skipped };
}

// Execute whatever behaviorAction the persona is configured for. Never clicks unsubscribe.
// Returns a PersonaAction record for the run history.
export async function performPersonaAction(
  persona: Persona,
  action: BehaviorAction,
  email: ParsedEmail | undefined,
): Promise<PersonaAction> {
  const now = new Date().toISOString();
  if (action === 'no_action') {
    return { persona, action: 'no_click', timestamp: now };
  }
  if (action === 'open_only') {
    return { persona, action: 'opened', timestamp: now, result: 'opened' };
  }
  if (action === 'reply') {
    return { persona, action: 'replied', timestamp: now, result: 'replied' };
  }
  if (action === 'unsubscribe') {
    // We still don't auto-click unsubscribe; we just record it for the plan.
    return { persona, action: 'unsubscribed', timestamp: now, result: 'unsubscribed' };
  }
  if (action === 'click_primary_cta') {
    const cta = email?.primaryCta;
    if (!cta) return { persona, action: 'failed_to_click', timestamp: now, result: 'failed' };
    if (cta.url === email?.unsubscribeLink) {
      return { persona, action: 'failed_to_click', url: cta.url, timestamp: now, result: 'failed' };
    }
    const check = await checkLink(cta.url);
    return {
      persona,
      action: 'clicked_primary_cta',
      url: cta.url,
      finalUrl: check.finalUrl || cta.url,
      timestamp: now,
      result: check.ok ? 'clicked' : 'failed',
    };
  }
  // 'custom' or 'submit_form' — record only
  return { persona, action: 'no_click', timestamp: now };
}
