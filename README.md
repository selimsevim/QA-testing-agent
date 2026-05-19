# InboxFlow Agent

**Autonomous email-marketing QA agent using Gmail seed inboxes and Gemini.**

You describe a campaign journey in plain English (or pick a pre-built demo flow). The agent infers the personas, builds an executable step plan with real timers, watches a Gmail seed inbox, exercises persona behaviours, probes every landing page, and reasons over each captured email to produce a launch-readiness report with concrete proof attached to every finding.

## Why

Email marketing teams manually verify journeys, branch logic, links, personalisation tokens, tracking parameters, and unsubscribe compliance before launch. Mistakes ship the wrong audience the wrong email, break landing pages, leak `{{first_name}}` tokens, and violate CAN-SPAM / GDPR. InboxFlow runs the whole QA pass autonomously and writes a marketer-readable report.

## What the agent does

1. **Trigger (demo only)** — fire SFMC Journey Builder entry events via the REST API so real emails are sent. Then hold for 3 minutes to let SFMC deliver before polling the inbox.
2. **Parse** a plain-language description of the journey into personas, branches, and a step plan with explicit wait timers.
3. **Watch** the seed Gmail inbox for incoming emails per persona, via Gmail aliases (`+welcomeclicker`, `+welcomenonclicker`, `+productx`, `+producty`, …).
4. **Classify** each captured message against the persona's expected labels (verbatim subject-match shortcut, then Gemini classification — no hardcoded keyword lists).
5. **Act** as each persona — click the primary CTA, hold back, etc. Never auto-touches ESP click-trackers or unsubscribe links.
6. **Probe** every non-tracking landing page (HEAD-then-GET) and capture title + visible-text excerpt as evidence.
7. **Reason** per-email via a single Gemini call that receives the email HTML, all link probes, the persona's CTA-click result, detected tokens, and UTM presence, and decides which findings to surface — in plain marketer language with cited URLs.
8. **Report** the result as Campaign Readiness + Persona Replay + Flow table + per-email Content & Links table, all with proofs and the captured email content rendered visually.
9. **Tag** every captured message into a per-run Gmail folder (e.g. `InboxFlow Tests/2026-05-19 03:37 — Subscription Confirmation`) and archive from Inbox.

## Design principles

- **One canonical verdict source**: `run.status` and `recommendation` are written exclusively from the QA report. The validator is a finding source, never a verdict source. The rail badge, the Test Runs list pill, and the modal verdict can never disagree.
- **Agent reasoning over hardcoded rules**: there is no placeholder-domain allow-list, no template-artifact keyword list, no HTTP-status-code phrasing table. The agent reads the actual page contents of every landing page and decides — for example — whether `example.com/confirm-subscription` is a real campaign destination (it isn't — IANA's documentation page) and writes the finding in its own words.
- **Plain language for marketers**: no `non-2xx`, no `HTTP 404`, no `utm_campaign=missing` jargon in any user-facing copy. The model is instructed to phrase everything the way a marketer would.
- **Evidence is non-negotiable**: every finding ships with proofs — a Gmail deep-link to the captured email, the URL the finding refers to, the page title at that URL, the offending snippet, etc.
- **Selective deep thinking**: Gemini 2.5's reasoning pass is off for structured calls (flow parsing, label classification, name derivation) and on for semantic checks (per-email reasoning, content alignment). Users only wait for deep checks.

## The UI

**Left rail.** Four views:
- **New Test** — type a free-form prompt; default landing view.
- **Test Runs** — list of all past runs with a status pill (Processing / Passed / Failed). Click a running row → resumes the live view with that run loaded and polling. Click a finished row → opens the report modal. Refreshes every 2s while anything is running.
- **Inbox** — live view of the Gmail seed inbox so judges can verify emails are arriving. Rail item shows `Inbox(N)` only when there are unread messages. Polls every 5s; rail badge every 8s. **Click any row** to expand a detail panel that renders the email in a sandboxed iframe with clickable links — judges can preview the email and test its CTA/unsubscribe destinations without leaving the app.
- **Demo** — replica of New Test, but the prompt is selected from a dropdown of two pre-built campaigns (no free typing). When the campaign has SFMC triggers wired, **Start Test Run** fires real Journey Builder entry events.

**Main column.** Persistent for both New Test and Demo:
- Page header with badge (Draft / Running / Failed / Ready).
- Prompt card (textarea or dropdown depending on view).
- Test personas card.
- Agent Activity card (collapsible). Live timeline of every step + result block with per-persona path status, blocker / warning counts, and a "Open run report" button.

**Report modal.** Top → bottom:
1. **Header** — campaign name, run ID, verdict pill, recommendation.
2. **Verdict banner** — green / red / blue.
3. **Campaign readiness** — Decision (`Ready to launch` / `Do not launch`), top 3 fixes, Re-test required Y/N. Slack/Jira-pasteable. Re-test now button appears when retest is required.
4. **Persona Replay** — micro-timeline per persona (`✉ Email 1 → ↪ clicked CTA → ✉ Email 2A → ✓ passed`). Email pills deep-link to Gmail.
5. **1. Flow** — per-path table: name, expected sequence, actual sequence, status, fix + proof.
6. **2. Content & Links** — one sub-table per (email, persona), with the **email's actual rendered HTML inline** inside a sandboxed iframe. Same set of checks for every email (Primary CTA link, CTA button, Other links, Unsubscribe, Unsubscribe page, Personalization, UTM tracking, Subject, Semantic consistency, Internal text), with a muted "—" pill for checks where there is nothing to verify (vs "✅ Passed" only when there is a real positive confirmation).
7. **Footer** — Open in Gmail, Re-test (only if retest required), **Export PDF** (browser `window.print()` → Save as PDF). Print CSS hides chrome, expands iframes, and avoids the blank-page bug.

## Architecture

```
React + Vite client (App.tsx + view components)
  ↓ HTTP + JSON
Express API (Node + TypeScript)
  ├─ SQLite (better-sqlite3, single file)         ← test_runs (indexed columns + JSON blob)
  ├─ Gmail service                                  ← OAuth, label management, label-and-archive
  ├─ Gemini service                                 ← parse+name (cached), classify labels,
  │                                                    reasonOverEmail (per-email semantic pass)
  ├─ Link checker                                   ← HEAD-then-GET probes, title + visible-text
  │                                                    extraction, ESP-tracker detection
  ├─ Flow validator                                 ← deterministic per-path branch correctness
  └─ Step runner                                    ← executes the step plan with real-time waits
       (start → sync → wait → action → wait → sync → validate → report)
```

### Step plan execution

Every run executes a deterministic plan derived from the parsed flow:

```
[fire-triggers → delivery-wait]?  →  start  → sync  → [wait → action → wait → sync]*  → validate  → report
```

- **fire-triggers (demo with SFMC)**: for runs that carry vendor triggers (the Demo view), the agent calls SFMC's REST API to fire each entry event (`POST /interaction/v1/events`) **before** any inbox polling. Failures are recorded in the activity timeline but don't abort the run.
- **delivery-wait (demo with SFMC)**: after at least one entry event fires successfully, the agent holds for **3 minutes** to let SFMC actually deliver the first email before polling. A clear "Journey is triggered — waiting for emails to arrive" event appears in the activity timeline with a live countdown. This wait is uncompressed even when `demoTimeCompression > 1`.
- **start**: marks the test plan as created.
- **sync**: queries Gmail (with the run's aliases) for new messages, classifies each one against the persona's expected labels, applies the run's Gmail folder, and archives from INBOX.
- **wait**: sleeps for the duration parsed from the prompt. Durations are re-extracted from the step `descr` text after Gemini parsing, so "Wait 5 minutes" always sleeps 5 minutes regardless of what the JSON said.
- **action**: simulates the persona's behaviour (click primary CTA / hold back / open-only / etc.). Never touches unsubscribe links. Never auto-probes ESP click-trackers (would record a false click).
- **validate**: runs the deterministic flow validator (branch correctness) and writes `paths` + legacy `findings`.
- **report**: probes every non-tracking landing page, then runs `reasonOverEmail` per captured email **in parallel**, then assembles the QA report and writes the canonical verdict.

### The reasoning agent (`reasonOverEmail`)

One Gemini call per captured email (Pro with reasoning **on** — the deep-check phase). The model receives:

- Campaign name + the marketer's flow description
- Persona display name + persona behaviour
- Email subject, anchor text, primary CTA URL, unsubscribe URL
- Whether the persona clicked the CTA, and the click outcome
- Detected unresolved tokens (machine fact)
- UTM presence across non-unsubscribe links (machine fact)
- For **every link in the email**: role (cta / unsubscribe / other / tracking), HTTP outcome, final URL after redirects, page `<title>`, and visible-text excerpt (`<head>`/`<style>`/`<script>` stripped before passing)
- The rendered visible body of the email (HTML stripped to text, anchor tags collapsed to their inner text so href-only URLs don't leak)

The model returns one entry per check category — every category, every email, for consistent rows across the report:

| Category               | What it covers                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| Primary CTA link       | Did the persona click succeed? Is the destination a real campaign page?        |
| CTA button             | Anchor text present, matches click intent.                                     |
| Other links            | Any non-CTA non-unsubscribe link that's broken or pointing somewhere odd.      |
| Unsubscribe            | Presence of an unsubscribe link in the email body.                             |
| Unsubscribe page       | Does the unsubscribe destination actually let the recipient opt out?           |
| Personalization        | Unresolved template tokens visible in the body.                                |
| UTM tracking           | Campaign tracking parameters on CTA links.                                     |
| Subject                | Subject is clear, not misleading, aligned with content.                        |
| Semantic consistency   | Subject + body + CTA + campaign goal align.                                    |
| Internal text          | Visible template-author leakage (TODOs, internal labels, Lorem ipsum).         |

Passes with empty findings render as muted "—" (nothing to verify); passes WITH a finding render as "✅ Passed" (real positive confirmation cited with proof).

### Model usage strategy

| Call                                | Model              | Thinking | Why                                              |
| ----------------------------------- | ------------------ | -------- | ------------------------------------------------ |
| `parseExpectedFlowAndName`          | `gemini-2.5-flash` | off      | Structured JSON parse + name in one round-trip.  |
| `classifyEmailLabel`                | `gemini-2.5-flash` | off      | One-of selection against candidate labels.       |
| `reasonOverEmail` (the deep check)  | env default (Pro)  | **on**   | Real reasoning — placeholder detection, semantic alignment, page-content judgment. |

`thinkingConfig.thinkingBudget: 0` bypasses Gemini 2.5's reasoning pass for the structured calls. Default temperature 0.2 across the board.

In-memory **parse cache** (LRU, 50 entries, keyed by trimmed prompt text) makes same-prompt re-tests instant — no Gemini round-trip at all.

## Storage

- **SQLite** at `server/data/inboxflow.sqlite`. Auto-created on first request. Single `test_runs` table with indexed columns (`id`, `campaign_name`, `status`, `created_at`, `started_at`, `finished_at`) plus a JSON `data` column for the full run snapshot. Legacy JSON-file runs (`server/data/test-runs.json`) are migrated into SQLite on first boot — the file is renamed `.migrated` afterwards.
- **Gmail tokens** in `server/data/gmail-tokens.json` (small, separate from SQLite so it can be wiped independently for re-OAuth).
- **Active-run id** in browser `localStorage` (`inboxflow.activeRunId`) so a page refresh restores the live view of an in-progress test. Cleared on completion.

## Setup

```bash
# 1. Install deps (root, server, client)
npm install

# 2. Copy environment file
cp .env.example .env
# Edit .env: APP_MODE=live, paste Gemini and Google OAuth credentials

# 3. Run server + client in parallel
npm run dev
```

Server: <http://localhost:4000>. Client: <http://localhost:5173> (Vite will shift to 5174/5175 if other instances are bound).

### Scripts

- `npm run dev` — server + client in parallel.
- `npm run dev:server` / `npm run dev:client` — individually.
- `npm run build` — typecheck + build both.
- `npm run start` — run built server.

## Gmail OAuth setup (live mode)

The agent needs the `gmail.modify` scope so it can create a label per run and apply it (read + label only — **never deletes, sends, or modifies email content**).

1. Create a Google Cloud project and enable the Gmail API.
2. **OAuth consent screen** → External, **Testing** publishing status.
3. Add your Gmail address (the seed inbox account) under **Test users**.
4. Create **OAuth 2.0 Client credentials** (Web application).
5. Add `http://localhost:4000/api/gmail/oauth/callback` as an authorised redirect URI.
6. Paste client id + secret into `.env`.
7. Click **Connect** in the rail. Approve the scopes. (Click *Advanced → Go to … (unsafe)* if Google warns the app is unverified — that's expected for a testing-mode app.)

The app detects token-scope mismatches (e.g. an old `gmail.readonly` token left over from a previous version) and surfaces a **Reconnect** button automatically.

### Scopes used

- `https://www.googleapis.com/auth/gmail.modify` — read + create label + apply label.
- `https://www.googleapis.com/auth/userinfo.email` — display connected account in the UI.

### Per-run Gmail folder

Each run creates (or reuses) a nested label like:

```
InboxFlow Tests
  └─ 2026-05-19 03:37 — Subscription Confirmation
```

The `/` in the label name makes Gmail nest it as a sub-folder under "InboxFlow Tests" in the sidebar. Captured emails are labelled AND removed from `INBOX` (archived into the folder).

## SFMC setup (demo trigger flow)

The Demo view fires real Journey Builder entry events for its pre-built campaigns. Two endpoints are involved:

- **Auth**: `POST https://<SFMC_SUBDOMAIN>.auth.marketingcloudapis.com/v2/token` — server-to-server OAuth (`grant_type=client_credentials`), tokens are cached in memory until ~30 seconds before expiry.
- **Fire event**: `POST https://<SFMC_SUBDOMAIN>.rest.marketingcloudapis.com/interaction/v1/events` — body: `{ ContactKey, EventDefinitionKey, Data: { SubscriberKey, Email, ... } }`.

To enable it, populate four env vars in `.env`:

```
SFMC_SUBDOMAIN=mclf...           # the prefix shared by your auth + REST hosts
SFMC_CLIENT_ID=<from server-to-server installed package>
SFMC_CLIENT_SECRET=<from server-to-server installed package>
SFMC_ACCOUNT_ID=<your MID, e.g. 536003187>
```

If any of these are missing, the Demo view shows an inline `⚠️ SFMC isn't configured` banner and the agent will still parse + watch the inbox — but no entry events fire, so no emails arrive.

`GET /api/config` exposes `sfmcConfigured: true | false` so the UI can show the warning ahead of time.

### Demo campaigns

The Demo view ships two pre-built campaigns:

1. **Welcome Campaign — Engagement check with timer.**
   - Aliases: `+welcomeclicker` (DD302) and `+welcomenonclicker` (DD303)
   - EventDefinitionKey: `APIEvent-67412dd3-017b-8e6d-014d-3f3d850992f3`
   - Behaviour: Send first email to both contacts with a "Finish setup" CTA. If `+welcomeclicker` clicks it, nothing else happens. If `+welcomenonclicker` doesn't click within 5 minutes, a reminder email with a "Verify email address" CTA fires.
   - **SFMC triggers wired** — clicking Start fires real events.

2. **Newsletter Campaign — Decision split by preference.**
   - Aliases: `+productx` and `+producty`
   - Behaviour: Two emails routed by alias. `productx` recipients receive the productx email; `producty` recipients receive the producty email.
   - **SFMC triggers NOT wired yet** (no ContactKey / EventDefinitionKey supplied). The agent will parse + watch but no entry events fire. The Demo view shows a warning when this preset is selected.

Selecting either populates the read-only prompt the agent will parse. Both flow through the same pipeline as a free-form prompt.

## Environment variables

| Variable                | Required    | Default                                              | Notes                                                                                              |
| ----------------------- | ----------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `APP_MODE`              | no          | `demo`                                               | `demo` or `live`.                                                                                  |
| `PORT`                  | no          | `4000`                                               | Server port.                                                                                       |
| `GEMINI_API_KEY`        | recommended | empty                                                | Without it, fallbacks to deterministic logic for parsing (no per-email reasoning).                |
| `GEMINI_MODEL`          | no          | `gemini-2.5-pro`                                     | Used for reasoning-heavy calls. Flash is hard-coded for structured / fast calls.                   |
| `GOOGLE_CLIENT_ID`      | live only   | —                                                    | Google OAuth client id.                                                                            |
| `GOOGLE_CLIENT_SECRET`  | live only   | —                                                    | Google OAuth client secret.                                                                        |
| `GOOGLE_REDIRECT_URI`   | no          | `http://localhost:4000/api/gmail/oauth/callback`    | OAuth callback URL.                                                                                |
| `CLIENT_URL`            | no          | `http://localhost:5173`                              | Used to redirect after OAuth.                                                                      |
| `SFMC_SUBDOMAIN`        | demo only   | —                                                    | TSE subdomain shared by both `*.auth.marketingcloudapis.com` and `*.rest.marketingcloudapis.com`. |
| `SFMC_CLIENT_ID`        | demo only   | —                                                    | Server-to-server installed package client id.                                                       |
| `SFMC_CLIENT_SECRET`    | demo only   | —                                                    | Server-to-server installed package client secret.                                                   |
| `SFMC_ACCOUNT_ID`       | demo only   | —                                                    | MID (e.g. `536003187`). Used in the OAuth body.                                                    |

## API

Run + report endpoints:

- `GET /api/health`
- `GET /api/config` — mode, model, Gmail connection state, scope-mismatch flag, seed inbox.
- `GET /api/test-runs` — list, newest first, from SQLite.
- `POST /api/test-runs` — create from a prompt. Server parses + derives the campaign name in one Gemini call; cached by prompt hash.
- `GET /api/test-runs/:id`
- `POST /api/test-runs/:id/start` — kick off the step plan asynchronously.
- `GET /api/test-runs/:id/events`
- `GET /api/test-runs/:id/report` — includes `qaReport` (readiness, replay, flow + content checks, every email's sanitised HTML for inline rendering, proofs on every finding).
- `POST /api/test-runs/:id/export?format=json|markdown` — server-side text export. UI uses browser PDF print instead.
- `POST /api/test-runs/:id/sync-gmail` — manual Gmail sync for ad-hoc debugging.

Gmail endpoints:

- `GET /api/gmail/auth-url` · `GET /api/gmail/oauth/callback`
- `GET /api/gmail/status` · `POST /api/gmail/sync`
- `GET /api/gmail/inbox` — recent INBOX messages (last 2 days, max 30) with subject/from/to/date/snippet/unread flag and `unreadCount`. Powers the Inbox view and the rail badge.
- `GET /api/gmail/inbox/:id` — full message body (`htmlBody` + `textBody`) for the Inbox detail panel.

Agent endpoints:

- `POST /api/agent/parse-flow` — preview the parsed flow without creating a run.

## Report format details

The QA report attached to every finished run:

```
QaReport {
  result:         'passed' | 'failed'
  recommendation: 'Ready to launch' | 'Do not launch'
  readiness:      { decision, topFixes[], retestRequired }
  replay:         PersonaReplay[]
  flowChecks:     FlowCheck[]
  emails:         EmailContentReport[]   ← each carries sanitized bodyHtml +
}                                          metadata (from/to/subject/receivedAt)
                                           and the 10-row check set.

FlowCheck { name, expected, actual, status, fix, proofs[] }
ContentCheck { name, status, finding, fix, proofs[] }
PersonaReplay {
  personaId, personaName, outcome, steps[]: { kind, label, status, emailId?, gmailUrl?, timestamp? }
}
Proof { kind: 'email' | 'link' | 'note' | 'timestamp', emailId?, gmailUrl?, subject?, url?, ... }
```

Proofs cite specific URLs / Gmail deep-links / page-text excerpts. Markdown export wraps them as `_(proof: …)_` after the fix text.

PDF export = browser `window.print()`. Print CSS hides chrome and lets sections break naturally across pages so multi-email reports don't leave blank gaps.

## Safety guardrails

- The LLM never executes Gmail actions directly. The backend decides actions from the parsed step plan and deterministic rules.
- Persona "click" behaviour never clicks unsubscribe links or unrelated links — only the detected primary CTA.
- ESP click-tracker redirectors (`cl.s##.exct.net`, `click.*`, `track.*`, `links.*`, `mailchimp`, `klaviyo`, `hubspot`, etc.) are never auto-fetched — would record a false click.
- Link health checks use HEAD first (with GET fallback) and a short timeout.
- The unsubscribe-page semantic check fetches the page with GET but only inspects the response body. It does not submit any form, so it cannot actually unsubscribe the user.
- Email body preview is sanitised server-side (`<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, inline event handlers, `javascript:` URLs all stripped) before being sent to the client. The report-modal iframe uses `sandbox="allow-same-origin"` with no `allow-scripts` (read-only). The **Inbox detail** iframe additionally has `allow-popups` so anchor clicks open in a new tab (without `allow-scripts` — scripts in the email still cannot run).
- Gmail labelling is additive + archive only. The agent never deletes, sends, or modifies email content.
- SFMC fire-entry-event uses server-to-server OAuth (`client_credentials`). Tokens are cached in memory only, never logged or persisted. The agent only POSTs to `/interaction/v1/events` — no other SFMC APIs are called.

## Architecture risks (known limits)

- **In-process orchestration.** `runStepPlan` is fire-and-forget from the route, and waits use `setTimeout`. State transitions are durably persisted to SQLite, so finished reports survive a crash — but in-flight `wait` timers do not. A production version would persist `nextStepAt` and replay scheduled steps on boot (or move execution to a job queue: BullMQ / pg-boss / Temporal). The data model is already queue-ready.

## Out of scope (intentional)

- Real SFMC / Marketo / Klaviyo integration.
- Sending email.
- Form-fill automation.
- Production OAuth verification.
- Multi-tenant workspaces, accounts, or billing.
- A chat-first interface or drag-and-drop flow builder.
