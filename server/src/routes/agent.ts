import { Router } from 'express';
import { parseExpectedFlow, geminiConfigured } from '../services/geminiService';

export const agentRouter = Router();

agentRouter.post('/parse-flow', async (req, res) => {
  const text = String(req.body?.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'missing_text' });
  try {
    const flow = await parseExpectedFlow(text);
    res.json({ ok: true, geminiUsed: geminiConfigured(), flow });
  } catch (err) {
    res.status(500).json({ error: 'parse_failed', message: (err as Error).message });
  }
});
