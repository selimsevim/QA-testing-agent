import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
// Load .env from project root first, then fall back to server/.env if present.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: false });
import express from 'express';
import cors from 'cors';
import { testRunsRouter } from './routes/testRuns';
import { gmailRouter } from './routes/gmail';
import { agentRouter } from './routes/agent';
import { gmailConfigured, getConnectionStatus } from './services/gmailService';
import { geminiConfigured } from './services/geminiService';
import { sfmcConfigured } from './services/sfmcService';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/config', (_req, res) => {
  const mode = (process.env.APP_MODE || 'demo').toLowerCase();
  const gmailStatus = getConnectionStatus();
  res.json({
    mode,
    geminiConfigured: geminiConfigured(),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    gmailConfigured: gmailConfigured(),
    gmailConnected: gmailStatus.connected,
    gmailEmail: gmailStatus.email,
    gmailNeedsReauth: !!gmailStatus.needsReauth,
    sfmcConfigured: sfmcConfigured(),
    seedInbox: 'sfmctest950@gmail.com',
  });
});

app.use('/api/test-runs', testRunsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/agent', agentRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'InboxFlow Agent API',
      message: 'Client build not found. Run npm run build from the project root to serve the web app.',
    });
  });
}

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('[server] error', err);
  res.status(500).json({ error: 'internal_error', message: err?.message });
});

app.listen(PORT, () => {
  const mode = (process.env.APP_MODE || 'demo').toLowerCase();
  console.log(`InboxFlow server listening on http://localhost:${PORT}`);
  console.log(`  mode: ${mode}`);
  console.log(`  gemini: ${geminiConfigured() ? 'configured' : 'not configured (deterministic fallback)'}`);
  console.log(`  gmail OAuth: ${gmailConfigured() ? 'configured' : 'not configured (demo only)'}`);
});
