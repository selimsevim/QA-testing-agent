import type { ConfigResponse, ExpectedFlow, InboxMessageDetail, InboxResponse, TestRun, TestRunReport } from './types';

const base = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async health(): Promise<{ ok: boolean }> {
    return json(await fetch(`${base}/health`));
  },
  async config(): Promise<ConfigResponse> {
    return json(await fetch(`${base}/config`));
  },
  async listRuns(): Promise<TestRun[]> {
    return json(await fetch(`${base}/test-runs`));
  },
  async parseFlow(text: string): Promise<{ ok: boolean; flow: ExpectedFlow; geminiUsed: boolean }> {
    return json(
      await fetch(`${base}/agent/parse-flow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    );
  },
  async createRun(body: {
    expectedFlowText?: string;
    demoCampaign?: 'welcome';
    demoTimeCompression?: number;
  }): Promise<TestRun> {
    return json(
      await fetch(`${base}/test-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async startRun(id: string): Promise<{ ok: boolean }> {
    return json(await fetch(`${base}/test-runs/${id}/start`, { method: 'POST' }));
  },
  async cancelRun(id: string): Promise<{ ok: boolean; status?: string }> {
    return json(await fetch(`${base}/test-runs/${id}/cancel`, { method: 'POST' }));
  },
  async getRun(id: string): Promise<TestRun> {
    return json(await fetch(`${base}/test-runs/${id}`));
  },
  async getReport(id: string): Promise<TestRunReport> {
    return json(await fetch(`${base}/test-runs/${id}/report`));
  },
  exportReportUrl(id: string, format: 'json' | 'markdown'): string {
    return `${base}/test-runs/${id}/export?format=${format}`;
  },
  async exportReport(id: string, format: 'json' | 'markdown'): Promise<Blob> {
    const res = await fetch(`${base}/test-runs/${id}/export?format=${format}`, { method: 'POST' });
    if (!res.ok) throw new Error('export failed');
    return res.blob();
  },
  async getGmailAuthUrl(): Promise<{ url: string }> {
    return json(await fetch(`${base}/gmail/auth-url`));
  },
  async inbox(): Promise<InboxResponse> {
    return json(await fetch(`${base}/gmail/inbox`));
  },
  async inboxMessage(id: string): Promise<InboxMessageDetail> {
    return json(await fetch(`${base}/gmail/inbox/${encodeURIComponent(id)}`));
  },
};
