import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { TestRun } from '../types';

const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'inboxflow.sqlite');
const LEGACY_TEST_RUNS_FILE = path.join(DATA_DIR, 'test-runs.json');
const GMAIL_CACHE_FILE = path.join(DATA_DIR, 'gmail-cache.json');
const GMAIL_TOKENS_FILE = path.join(DATA_DIR, 'gmail-tokens.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id            TEXT PRIMARY KEY,
      campaign_name TEXT NOT NULL,
      status        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT,
      data          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_runs_created_at ON test_runs(created_at DESC);
    CREATE TABLE IF NOT EXISTS processed_emails (
      gmail_id      TEXT PRIMARY KEY,
      campaign_name TEXT NOT NULL,
      alias         TEXT NOT NULL,
      email_date    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      recorded_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processed_campaign_alias_date
      ON processed_emails(campaign_name, alias, email_date);
  `);
  migrateLegacyJson(_db);
  return _db;
}

function migrateLegacyJson(database: Database.Database) {
  if (!fs.existsSync(LEGACY_TEST_RUNS_FILE)) return;
  const row = database.prepare('SELECT COUNT(*) AS c FROM test_runs').get() as { c: number };
  if (row && row.c > 0) return;
  try {
    const raw = fs.readFileSync(LEGACY_TEST_RUNS_FILE, 'utf8');
    if (!raw.trim()) return;
    const runs = JSON.parse(raw) as TestRun[];
    if (!Array.isArray(runs)) return;
    const stmt = database.prepare(
      'INSERT INTO test_runs (id, campaign_name, status, created_at, started_at, finished_at, data) VALUES (?,?,?,?,?,?,?)',
    );
    const tx = database.transaction((items: TestRun[]) => {
      for (const r of items) {
        stmt.run(
          r.id,
          r.campaignName,
          r.status,
          r.createdAt,
          r.startedAt || null,
          r.finishedAt || null,
          JSON.stringify(r),
        );
      }
    });
    tx(runs);
    fs.renameSync(LEGACY_TEST_RUNS_FILE, LEGACY_TEST_RUNS_FILE + '.migrated');
    console.log(`[store] migrated ${runs.length} runs from JSON to SQLite`);
  } catch (err) {
    console.warn('[store] legacy JSON migration failed:', (err as Error).message);
  }
}

function rowToRun(row: { data: string }): TestRun {
  return JSON.parse(row.data) as TestRun;
}

export function listTestRuns(): TestRun[] {
  const rows = db().prepare('SELECT data FROM test_runs ORDER BY created_at DESC').all() as { data: string }[];
  return rows.map(rowToRun);
}

export function getTestRun(id: string): TestRun | undefined {
  const row = db().prepare('SELECT data FROM test_runs WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? rowToRun(row) : undefined;
}

export function saveTestRun(run: TestRun): TestRun {
  db()
    .prepare(
      `INSERT INTO test_runs (id, campaign_name, status, created_at, started_at, finished_at, data)
       VALUES (@id, @campaign_name, @status, @created_at, @started_at, @finished_at, @data)
       ON CONFLICT(id) DO UPDATE SET
         campaign_name = excluded.campaign_name,
         status        = excluded.status,
         created_at    = excluded.created_at,
         started_at    = excluded.started_at,
         finished_at   = excluded.finished_at,
         data          = excluded.data`,
    )
    .run({
      id: run.id,
      campaign_name: run.campaignName,
      status: run.status,
      created_at: run.createdAt,
      started_at: run.startedAt || null,
      finished_at: run.finishedAt || null,
      data: JSON.stringify(run),
    });
  return run;
}

export function updateTestRun(id: string, mut: (r: TestRun) => void): TestRun | undefined {
  const current = getTestRun(id);
  if (!current) return undefined;
  mut(current);
  saveTestRun(current);
  return current;
}

export function deleteTestRun(id: string): boolean {
  const res = db().prepare('DELETE FROM test_runs WHERE id = ?').run(id);
  return res.changes > 0;
}

// --- Cross-run processed-email tracking ---
//
// Same campaign re-run: we don't want to count emails that an earlier run already
// processed. Key on (campaign_name, alias, email_date) so the dedupe is anchored to
// the email's send time + the persona alias it was sent to, which is stable across
// re-runs even if Gmail somehow re-issues an id.

export function processedEmailKey(alias: string, emailDate: string): string {
  return `${(alias || '').toLowerCase()}|${emailDate || ''}`;
}

export function listProcessedEmailKeys(campaignName: string): Set<string> {
  const rows = db()
    .prepare('SELECT alias, email_date FROM processed_emails WHERE campaign_name = ?')
    .all(campaignName) as { alias: string; email_date: string }[];
  const out = new Set<string>();
  for (const r of rows) out.add(processedEmailKey(r.alias, r.email_date));
  return out;
}

export function recordProcessedEmails(
  campaignName: string,
  runId: string,
  entries: { gmailId: string; alias: string; emailDate: string }[],
): void {
  if (!entries.length) return;
  const stmt = db().prepare(
    `INSERT INTO processed_emails (gmail_id, campaign_name, alias, email_date, run_id, recorded_at)
     VALUES (@gmail_id, @campaign_name, @alias, @email_date, @run_id, @recorded_at)
     ON CONFLICT(gmail_id) DO NOTHING`,
  );
  const now = new Date().toISOString();
  const tx = db().transaction((items: typeof entries) => {
    for (const e of items) {
      stmt.run({
        gmail_id: e.gmailId,
        campaign_name: campaignName,
        alias: (e.alias || '').toLowerCase(),
        email_date: e.emailDate || '',
        run_id: runId,
        recorded_at: now,
      });
    }
  });
  tx(entries);
}

// --- Gmail tokens + cache stay in their JSON files for now ---

function readJson<T>(file: string, fallback: T): T {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(file: string, data: T) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export interface GmailTokens {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  email?: string;
}

export function readGmailTokens(): GmailTokens | null {
  const t = readJson<GmailTokens | null>(GMAIL_TOKENS_FILE, null);
  return t && t.access_token ? t : null;
}

export function writeGmailTokens(tokens: GmailTokens) {
  writeJson(GMAIL_TOKENS_FILE, tokens);
}

export function clearGmailTokens() {
  if (fs.existsSync(GMAIL_TOKENS_FILE)) fs.unlinkSync(GMAIL_TOKENS_FILE);
}

export function readGmailCache(): any {
  return readJson<any>(GMAIL_CACHE_FILE, { messages: [] });
}

export function writeGmailCache(data: any) {
  writeJson(GMAIL_CACHE_FILE, data);
}
