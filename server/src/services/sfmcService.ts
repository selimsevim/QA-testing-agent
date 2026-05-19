// Salesforce Marketing Cloud — REST API helpers.
//
// Two operations:
//   1) getAccessToken() — server-to-server OAuth (client_credentials) against
//      https://<subdomain>.auth.marketingcloudapis.com/v2/token. We cache the
//      token in memory until ~30 seconds before its `expires_in` so back-to-back
//      runs don't re-authenticate.
//   2) fireEntryEvent({ contactKey, eventDefinitionKey, data }) — POSTs to
//      https://<subdomain>.rest.marketingcloudapis.com/interaction/v1/events
//      which is SFMC's "fire entry event" endpoint that injects a contact into
//      a Journey Builder journey.

export interface SfmcConfig {
  subdomain: string;
  clientId: string;
  clientSecret: string;
  accountId: string;
}

export function getSfmcConfig(): SfmcConfig | null {
  const subdomain = process.env.SFMC_SUBDOMAIN || '';
  const clientId = process.env.SFMC_CLIENT_ID || '';
  const clientSecret = process.env.SFMC_CLIENT_SECRET || '';
  const accountId = process.env.SFMC_ACCOUNT_ID || '';
  if (!subdomain || !clientId || !clientSecret || !accountId) return null;
  return { subdomain, clientId, clientSecret, accountId };
}

export function sfmcConfigured(): boolean {
  return getSfmcConfig() !== null;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

export async function getAccessToken(): Promise<string> {
  const cfg = getSfmcConfig();
  if (!cfg) throw new Error('SFMC is not configured — set SFMC_SUBDOMAIN, SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_ACCOUNT_ID.');

  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.accessToken;
  }

  const url = `https://${cfg.subdomain}.auth.marketingcloudapis.com/v2/token`;
  const body = {
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    account_id: cfg.accountId,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SFMC token request failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`SFMC token response was not JSON: ${text.slice(0, 200)}`);
  }
  const accessToken = parsed.access_token;
  const expiresInSec = Number(parsed.expires_in || 1080); // SFMC default is 1080 sec (18 min)
  if (!accessToken) {
    throw new Error('SFMC token response had no access_token');
  }
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
  return accessToken;
}

export interface FireEntryEventInput {
  contactKey: string;
  eventDefinitionKey: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface FireEntryEventResult {
  ok: boolean;
  status: number;
  eventInstanceId?: string;
  raw?: any;
  error?: string;
}

export async function fireEntryEvent(input: FireEntryEventInput): Promise<FireEntryEventResult> {
  const cfg = getSfmcConfig();
  if (!cfg) return { ok: false, status: 0, error: 'SFMC not configured' };

  const token = await getAccessToken();
  const url = `https://${cfg.subdomain}.rest.marketingcloudapis.com/interaction/v1/events`;
  const body = {
    ContactKey: input.contactKey,
    EventDefinitionKey: input.eventDefinitionKey,
    Data: input.data || { SubscriberKey: input.contactKey },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* response may be plain text */
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      raw: parsed || text,
      error: typeof parsed === 'object' && parsed?.message ? parsed.message : `HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    status: res.status,
    eventInstanceId: parsed?.eventInstanceId || parsed?.eventInstance?.id,
    raw: parsed,
  };
}
