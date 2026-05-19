import { Router } from 'express';
import {
  exchangeCode,
  getAuthUrl,
  getConnectionStatus,
  getInboxMessage,
  gmailConfigured,
  listInbox,
  syncMessages,
} from '../services/gmailService';

export const gmailRouter = Router();

gmailRouter.get('/auth-url', (_req, res) => {
  if (!gmailConfigured()) return res.status(400).json({ error: 'gmail_not_configured' });
  const url = getAuthUrl();
  if (!url) return res.status(500).json({ error: 'auth_url_failed' });
  res.json({ url });
});

gmailRouter.get('/oauth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens = await exchangeCode(code);
    if (!tokens) return res.status(500).send('Token exchange failed');
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/?gmail=connected`);
  } catch (err) {
    res.status(500).send('OAuth error: ' + (err as Error).message);
  }
});

gmailRouter.get('/status', (_req, res) => {
  res.json(getConnectionStatus());
});

gmailRouter.get('/inbox', async (_req, res) => {
  if (!gmailConfigured()) return res.status(400).json({ error: 'gmail_not_configured' });
  try {
    const result = await listInbox({ maxResults: 30, windowDays: 2 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'inbox_failed', message: (err as Error).message });
  }
});

gmailRouter.get('/inbox/:id', async (req, res) => {
  if (!gmailConfigured()) return res.status(400).json({ error: 'gmail_not_configured' });
  try {
    const msg = await getInboxMessage(String(req.params.id || ''));
    if (!msg) return res.status(404).json({ error: 'not_found' });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: 'inbox_message_failed', message: (err as Error).message });
  }
});

gmailRouter.post('/sync', async (req, res) => {
  if (!gmailConfigured()) return res.status(400).json({ error: 'gmail_not_configured' });
  try {
    const campaignName = String(req.body?.campaignName || '');
    const seedInbox = String(req.body?.seedInbox || '');
    const personas = Array.isArray(req.body?.personas) ? req.body.personas : [];
    const result = await syncMessages({ campaignName, seedInbox, personas });
    res.json({ ok: true, count: result.emails.length, ...result });
  } catch (err) {
    res.status(500).json({ error: 'sync_failed', message: (err as Error).message });
  }
});
