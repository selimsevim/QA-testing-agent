# InboxFlow Agent

Autonomous QA for email marketing journeys. InboxFlow takes a plain-language campaign flow, infers the personas and waits, watches a seed inbox, exercises configured persona behavior, checks landing pages, and produces an evidence-backed launch-readiness report.

The app is a React/Vite client plus an Express/TypeScript API. It can run in a self-contained demo mode, or in live mode with Gmail OAuth, Gemini, and optional Salesforce Marketing Cloud (SFMC) entry-event triggers.

## Demo

Watch the demo post on LinkedIn: [InboxFlow Agent demo](https://www.linkedin.com/posts/selim-sevim-8b7204102_lablab-ai-aiagents-ugcPost-7462811223483482113-Lwl-?utm_source=share&utm_medium=member_desktop&rcm=ACoAABoD2AsBe1-vgTEVnPRE8RWgqlFzqgrO6mE).

## What It Checks

InboxFlow is built for pre-launch email QA:

- Parses a marketer's journey description into personas, branches, expected email labels, actions, and timed steps.
- Watches for Gmail messages addressed to persona aliases such as `+welcomeclicker` and `+welcomenonclicker`.
- Classifies each captured email against the expected branch labels.
- Performs persona actions such as clicking the primary CTA or intentionally taking no action.
- Runs deterministic flow validation for missing emails, duplicate sends, and wrong-branch deliveries.
- Scans email content for common machine-detectable risks such as unresolved personalization tokens, missing unsubscribe links, and missing `utm_campaign`.
- Probes landing pages and captures final URL, page title, and visible page text as proof.
- Uses Gemini for semantic checks when configured: placeholder destinations, CTA/content alignment, unsubscribe-page quality, subject fit, and internal/template text leakage.
- Writes a report with campaign readiness, persona replay, flow checks, content/link checks, Gmail deep links, and inline rendered email previews.

## Repository Layout

```text
.
|-- client/                         React + Vite frontend
|   `-- src/
|       |-- App.tsx                 Main UI and run orchestration
|       |-- api.ts                  Browser API client
|       `-- components/             Sidebar, inbox, activity, report modal, run list
|-- server/                         Express + TypeScript backend
|   `-- src/
|       |-- index.ts                Server entrypoint and /api/config
|       |-- routes/                 HTTP routes
|       `-- services/
|           |-- stepRunner.ts       Sequential run executor
|           |-- geminiService.ts    Flow parsing, labeling, QA report reasoning
|           |-- gmailService.ts     OAuth, inbox sync, labels, dedupe filtering
|           |-- flowValidator.ts    Deterministic branch validation
|           |-- linkChecker.ts      Link probes and persona actions
|           |-- sfmcService.ts      SFMC server-to-server auth + event firing
|           |-- demoPresets.ts      Demo campaign definitions
|           |-- demoSimulator.ts    Demo-mode email injection
|           `-- store.ts            SQLite and JSON-backed local state
|-- server/data/                    Local runtime data: SQLite, WAL, cache, Gmail tokens
|-- inboxflow-demo-presentation.html Standalone HTML demo deck
|-- package.json                    Root scripts for server/client orchestration
`-- .env.example                    Environment variable template
```

Generated build folders such as `client/dist` and `server/dist` are ignored by git.

## Runtime Modes

`APP_MODE` controls how runs sync email:

- `APP_MODE=demo` - no Gmail OAuth is required. Sync steps use the deterministic demo simulator. Demo-time compression is available in the UI.
- `APP_MODE=live` plus Google OAuth credentials and a connected Gmail account - sync steps use the Gmail API.
- `APP_MODE=live` without a configured/connected Gmail account - the backend falls back to the demo simulator so the app can still run.

Gemini is optional but strongly recommended. Without `GEMINI_API_KEY`, flow parsing falls back to deterministic heuristics and the semantic per-email report is reduced.

## Setup

```bash
# Install root, server, and client dependencies.
npm install

# Create an env file if one was not already created by predev.
cp .env.example .env

# Edit .env for the mode you want.
# For live Gmail runs: set APP_MODE=live, Gemini, and Google OAuth values.
# For SFMC-triggered live demo runs: also set the SFMC values.

# Start API and client together.
npm run dev
```

The API listens on `http://localhost:4000`.
The Vite client listens on `http://localhost:5173` unless Vite shifts to another free port.

The root `predev` script copies `.env.example` to `.env` when `.env` is missing. The root `postinstall` script installs both `server/` and `client/` dependencies.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run server and client in parallel. The client waits for port `4000`. |
| `npm run dev:server` | Run only the Express API with `tsx watch`. |
| `npm run dev:client` | Run only the Vite client. |
| `npm run build` | Typecheck/build the server, then typecheck/build the client. |
| `npm run start` | Run the built server from `server/dist/index.js`. If `client/dist` exists, the server also serves the frontend. |
| `npm run install:all` | Install root, server, and client dependencies explicitly. |

There is no test script currently; `npm run build` is the main repository verification command.

## Environment Variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_MODE` | no | `demo` | `demo` or `live`. Live Gmail sync only happens when this is `live` and Gmail is configured/connected. |
| `PORT` | no | `4000` | Express API port. |
| `GEMINI_API_KEY` | recommended | empty | Enables Gemini parsing, classification, semantic flow-fix phrasing, and per-email reasoning. |
| `GEMINI_MODEL` | no | `gemini-2.5-pro` | Used for reasoning-heavy calls. Fast structured calls use `gemini-2.5-flash`. |
| `GOOGLE_CLIENT_ID` | live Gmail only | empty | Google OAuth web client id. |
| `GOOGLE_CLIENT_SECRET` | live Gmail only | empty | Google OAuth web client secret. |
| `GOOGLE_REDIRECT_URI2` | no | `http://localhost:4000/api/gmail/oauth/callback` | OAuth redirect URI. Must match Google Cloud. |
| `CLIENT_URL2` | no | `http://localhost:5173` | Browser URL to redirect to after OAuth completes. |
| `SFMC_SUBDOMAIN` | SFMC trigger only | empty | Prefix shared by SFMC auth and REST hosts. |
| `SFMC_CLIENT_ID` | SFMC trigger only | empty | SFMC server-to-server installed package client id. |
| `SFMC_CLIENT_SECRET` | SFMC trigger only | empty | SFMC server-to-server installed package client secret. |
| `SFMC_ACCOUNT_ID` | SFMC trigger only | empty | SFMC MID/account id included in the token request. |

## Gmail OAuth

Live Gmail runs require `https://www.googleapis.com/auth/gmail.modify` so the agent can read messages, create labels, apply the per-run label, and archive captured messages out of `INBOX`. The app never sends email, deletes email, or edits message content.

1. Create a Google Cloud project and enable the Gmail API.
2. Configure the OAuth consent screen. For local testing, External + Testing is enough.
3. Add the seed inbox account as a test user.
4. Create OAuth 2.0 Web application credentials.
5. Add `http://localhost:4000/api/gmail/oauth/callback` as an authorized redirect URI.
6. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and optionally `GOOGLE_REDIRECT_URI2` in `.env`.
7. Start the app, then use the Connect/Reconnect button in the sidebar.

The backend stores Gmail tokens in `server/data/gmail-tokens.json`. If an older token does not include `gmail.modify`, `/api/config` marks `gmailNeedsReauth: true` and the sidebar shows Reconnect.

## Seed Inbox And Aliases

The backend exposes a fixed seed inbox value of `sfmctest950@gmail.com` in `/api/config` and run records. Live Gmail sync does not search by that exact address. Instead, it scans recent Gmail messages and filters in code by persona aliases found in recipient headers or snippets. This supports routed or forwarded sandbox addresses where the alias tag lives on another local part.

Persona aliases are inferred from persona ids as `+<id without underscores>` unless Gemini returns an explicit alias. Examples:

- `clicker` -> `+clicker`
- `non_clicker` -> `+nonclicker`
- `welcome_clicker` -> `+welcomeclicker`

## SFMC Entry-Event Setup

The Demo view can attach vendor triggers to a run. Currently the only implemented vendor is SFMC Journey Builder entry events:

- Auth: `POST https://<SFMC_SUBDOMAIN>.auth.marketingcloudapis.com/v2/token`
- Fire event: `POST https://<SFMC_SUBDOMAIN>.rest.marketingcloudapis.com/interaction/v1/events`

The token request uses `grant_type=client_credentials` and includes `account_id`. Access tokens are cached in memory until roughly 30 seconds before expiry.

Required `.env` values:

```bash
SFMC_SUBDOMAIN=
SFMC_CLIENT_ID=
SFMC_CLIENT_SECRET=
SFMC_ACCOUNT_ID=
```

When a run has triggers and SFMC is configured, the runner fires all entry events in parallel before the parsed step plan starts. If at least one trigger succeeds, it polls Gmail metadata every 15 seconds for up to 3 minutes, looking for one message per persona alias. The run then continues into the normal sync/action/validate/report steps. When `demoTimeCompression` is supplied, this delivery poll is compressed the same way as wait steps.

If SFMC values are missing, the runner records a "Skipping SFMC entry events" activity item and continues. In demo mode, simulated emails can still be injected by the demo simulator. To verify real SFMC email delivery, use `APP_MODE=live`, connect Gmail, and configure SFMC.

## Current Demo Preset

The repository currently exposes one demo campaign in both `client/src/App.tsx` and `server/src/services/demoPresets.ts`:

**Welcome Campaign - Engagement check with timer**

- Prompt: two contacts receive the first email. `+welcomeclicker` clicks "Finish setup"; `+welcomenonclicker` does not click and should receive a reminder after 3 minutes.
- Triggered contacts: `sels+welcomeclicker@redpill-linpro.com` and `sels+welcomenonclicker@redpill-linpro.com`.
- Contact keys: `DD302` and `DD303`.
- EventDefinitionKey: `APIEvent-67412dd3-017b-8e6d-014d-3f3d850992f3`.

## Run Lifecycle

Every run stores an executable step plan in SQLite. The runner walks it sequentially:

```text
[fire SFMC triggers + delivery poll]? -> start -> sync -> [wait -> action -> wait -> sync]* -> validate -> report
```

Step behavior:

- `start` records that the test plan was created.
- `sync` either queries Gmail or injects demo emails, classifies labels, checks safe non-action links, creates/applies the run's Gmail label in live mode, and archives captured messages from Inbox.
- `wait` sleeps for the parsed duration. Demo compression divides the wait length by `demoTimeCompression`.
- `action` records persona behavior. Click actions target only the detected primary CTA and never execute unsubscribe links.
- `validate` runs deterministic branch validation and writes `paths` plus legacy `findings`.
- `report` probes landing pages, runs per-email reasoning when Gemini is available, writes `qaReport`, and sets the canonical run verdict.

The UI can cancel a running job through `POST /api/test-runs/:id/cancel`. Cancellation is cooperative: long waits wake up periodically and stop once the runner sees the cancel flag. Cancelled runs finish with status `cancelled`.

## UI Overview

The client has four sidebar views:

- **New Test** - free-form prompt entry for custom flows.
- **Test Runs** - persisted run list, newest first. Running rows resume the live view; finished rows open the report.
- **Inbox** - recent Gmail Inbox messages with unread count, expandable detail rows, rendered email preview, and Gmail links.
- **Demo** - read-only preset prompt plus demo-time compression control.

The main run view shows:

- Run status badge: Draft, Running, Failed, or Ready.
- Prompt/preset card.
- Parsed personas with alias and action.
- Collapsible Agent Activity timeline.
- Per-persona path status plus blocker/warning counts.
- Stop button while a run is active.

The report modal shows:

- Header with run id, result, and recommendation.
- Campaign readiness with top fixes and retest requirement.
- Delivery timing when SFMC trigger delivery was measured.
- Persona replay timeline.
- Flow check table.
- Content & Links table for each captured email.
- Inline sandboxed email preview.
- Open in Gmail, Re-test, and browser `window.print()` PDF export.

Markdown/JSON report export is available through the API. PDF export is intentionally browser print so the rendered email previews are included.

## Storage

Runtime state lives under `server/data/`:

- `inboxflow.sqlite` - SQLite database, auto-created on first use.
- `test_runs` table - indexed run metadata plus a JSON snapshot in `data`.
- `processed_emails` table - cross-run dedupe keyed by campaign, persona alias, and email date so reruns do not double-count older messages.
- `gmail-tokens.json` - OAuth tokens and connected email address.
- `gmail-cache.json` - latest Gmail sync cache.

Legacy `server/data/test-runs.json` files are migrated into SQLite on first boot if the database is empty. After migration the JSON file is renamed to `test-runs.json.migrated`.

The browser stores the active running id in `localStorage` as `inboxflow.activeRunId`, so refreshing the page resumes a live run.

## API Reference

Configuration:

- `GET /api/health` - service heartbeat.
- `GET /api/config` - mode, Gemini model/config state, Gmail connection state, SFMC config state, and seed inbox.

Runs:

- `GET /api/test-runs` - list runs newest first.
- `POST /api/test-runs` - create a draft run. Body accepts `expectedFlowText`, or `demoCampaign: "welcome"`, plus optional `demoTimeCompression`.
- `GET /api/test-runs/:id` - get the full run snapshot.
- `POST /api/test-runs/:id/start` - start the asynchronous runner.
- `POST /api/test-runs/:id/cancel` - request cooperative cancellation.
- `GET /api/test-runs/:id/events` - get activity timeline events.
- `GET /api/test-runs/:id/report` - get `TestRunReport`.
- `POST /api/test-runs/:id/export?format=json|markdown` - download JSON or Markdown report.
- `POST /api/test-runs/:id/sync-gmail` - manually sync Gmail for an existing run.

Gmail:

- `GET /api/gmail/auth-url` - create an OAuth authorization URL.
- `GET /api/gmail/oauth/callback` - OAuth redirect handler.
- `GET /api/gmail/status` - connection and reauth status.
- `POST /api/gmail/sync` - ad-hoc sync by campaign/personas.
- `GET /api/gmail/inbox` - recent Inbox summary, last 2 days, up to 30 messages.
- `GET /api/gmail/inbox/:id` - full message body for the Inbox detail panel.

Agent:

- `POST /api/agent/parse-flow` - parse a prompt without creating a run.

## Report Shape

Finished runs include a `qaReport`:

```ts
interface QaReport {
  result: 'passed' | 'failed';
  recommendation: 'Ready to launch' | 'Do not launch';
  readiness: {
    decision: 'Ready to launch' | 'Do not launch';
    topFixes: string[];
    retestRequired: boolean;
  };
  replay: PersonaReplay[];
  flowChecks: FlowCheck[];
  emails: EmailContentReport[];
}
```

Each email report carries sanitized HTML for rendering and a stable set of semantic check categories when Gemini reasoning is available:

- Primary CTA link
- CTA button
- Other links
- Unsubscribe
- Unsubscribe page
- Personalization
- UTM tracking
- Subject
- Semantic consistency
- Internal text

Proof objects can cite Gmail messages, links, timestamps, or notes. Gmail proofs use deep links like `https://mail.google.com/mail/u/0/#all/<messageId>`.

## Safety Guardrails

- The LLM never directly executes Gmail or SFMC actions. Backend code owns side effects.
- Gmail scope is `gmail.modify`, used for read, label creation, label application, and archive-from-Inbox only.
- The agent never sends, deletes, or edits email content.
- Persona click actions target only the detected primary CTA and refuse unsubscribe links.
- Unsubscribe persona actions are recorded, not executed.
- The sync-time link health scan skips primary CTA and unsubscribe links to avoid false engagement and opt-out side effects.
- Report-time page probing fetches link destinations for evidence and semantic analysis. Use care with real campaigns whose non-CTA links are also click-tracked.
- Email previews are stripped of scripts, iframes, objects, embeds, forms, inline event handlers, and `javascript:` URLs before report rendering. Report iframes run without `allow-scripts`.
- Inbox detail previews run in a sandboxed iframe with popups allowed so a user can manually open links in a new tab, but scripts still cannot execute.
- SFMC integration only calls `/interaction/v1/events`; no other SFMC APIs are used.
- SFMC access tokens are cached only in memory and are not persisted.

## Known Limits

- The runner is in-process. Run snapshots are persisted, but active timers are not replayed after a server crash or restart.
- There is no production job queue, scheduler, or multi-worker locking.
- There is no multi-tenant account model, RBAC, billing, or production OAuth verification.
- Only Gmail is implemented as the inbox provider.
- Only SFMC Journey Builder entry events are implemented as campaign triggers.
- Marketo, Klaviyo, and other ESP integrations are not implemented.
- Form-fill automation is intentionally out of scope.
- The demo simulator deliberately creates flawed demo evidence for walkthroughs; it is not a replacement for live Gmail/SFMC verification.

## Demo Deck

`inboxflow-demo-presentation.html` is a standalone browser presentation deck for pitching or walking through the product story. It is not required to run the app.
